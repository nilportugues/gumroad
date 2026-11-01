// Port of @inertiajs/react 2.3.13 useForm without Precognition (no page uses it). State handling is
// kept line-for-line so callbacks see the same sequence of processing/errors/defaults updates.
import { cloneDeep, get, has, isEqual, set } from "lodash-es";
import * as React from "react";

import { router } from "./router";
import type {
  ErrorValue,
  FormDataErrors,
  FormDataKeys,
  FormDataType,
  FormDataValues,
  Method,
  RequestPayload,
  VisitOptions,
} from "./types";
import { useRemember } from "./use-remember";

const RECENTLY_SUCCESSFUL_DURATION_MS = 2000;

type TransformCallback<TForm> = (data: TForm) => object;
type SubmitOptions = Omit<VisitOptions, "data">;
type UrlMethodPair = { url: string; method: Method };
type SubmitArguments = [Method, string, SubmitOptions?] | [UrlMethodPair, SubmitOptions?];

export interface InertiaFormProps<TForm extends object> {
  data: TForm;
  isDirty: boolean;
  errors: FormDataErrors<TForm>;
  hasErrors: boolean;
  processing: boolean;
  progress: unknown;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  setData: {
    (data: Partial<TForm>): void;
    (update: (previousData: TForm) => TForm): void;
    <K extends FormDataKeys<TForm>>(key: K, value: FormDataValues<TForm, K>): void;
  };
  transform: (callback: TransformCallback<TForm>) => void;
  setDefaults: {
    (): void;
    <K extends FormDataKeys<TForm>>(field: K, value: FormDataValues<TForm, K>): void;
    (fields: Partial<TForm>): void;
  };
  reset: <K extends FormDataKeys<TForm>>(...fields: K[]) => void;
  clearErrors: <K extends FormDataKeys<TForm>>(...fields: K[]) => void;
  resetAndClearErrors: <K extends FormDataKeys<TForm>>(...fields: K[]) => void;
  setError: {
    <K extends FormDataKeys<TForm>>(field: K, value: ErrorValue): void;
    (errors: FormDataErrors<TForm>): void;
  };
  submit: (...args: SubmitArguments) => void;
  get: (url: string, options?: SubmitOptions) => void;
  post: (url: string, options?: SubmitOptions) => void;
  put: (url: string, options?: SubmitOptions) => void;
  patch: (url: string, options?: SubmitOptions) => void;
  delete: (url: string, options?: SubmitOptions) => void;
  cancel: () => void;
}

export type InertiaForm<TForm extends object> = InertiaFormProps<TForm>;

function parseArguments<TForm>(args: unknown[]): { rememberKey: string | null; data: TForm | (() => TForm) } {
  if (args.length === 0) return { rememberKey: null, data: {} as TForm };
  if (args.length === 1) return { rememberKey: null, data: args[0] as TForm };
  if (typeof args[0] === "string") return { rememberKey: args[0], data: args[1] as TForm };
  throw new Error("useForm with a Precognition endpoint is not supported by @/lib/navigation");
}

function parseSubmitArguments(args: SubmitArguments): { method: Method; url: string; options: SubmitOptions } {
  if (typeof args[0] === "string") return { method: args[0], url: args[1] as string, options: (args[2] as SubmitOptions) ?? {} };
  return { ...args[0], options: (args[1] as SubmitOptions) ?? {} };
}

export function useForm<TForm extends FormDataType<TForm>>(rememberKey: string, data: TForm | (() => TForm)): InertiaFormProps<TForm>;
export function useForm<TForm extends FormDataType<TForm>>(data: TForm | (() => TForm)): InertiaFormProps<TForm>;
export function useForm<TForm extends FormDataType<TForm>>(): InertiaFormProps<TForm>;
export function useForm<TForm extends FormDataType<TForm>>(...args: unknown[]): InertiaFormProps<TForm> {
  const isMounted = React.useRef(false);
  const { rememberKey, data: initialData } = parseArguments<TForm>(args);

  const [defaults, setDefaults] = React.useState<TForm>(() =>
    cloneDeep(typeof initialData === "function" ? (initialData as () => TForm)() : initialData),
  );
  const cancelToken = React.useRef<{ cancel: () => void } | null>(null);
  const recentlySuccessfulTimeoutId = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hooks run unconditionally; the remembered variants only persist when a key was given.
  const [data, setData] = useRemember<TForm>(defaults, rememberKey ? `${rememberKey}:data` : null);
  const [errors, setErrors] = useRemember<FormDataErrors<TForm>>({} as FormDataErrors<TForm>, rememberKey ? `${rememberKey}:errors` : null);
  const [hasErrors, setHasErrors] = React.useState(false);
  const [processing, setProcessing] = React.useState(false);
  const [progress, setProgress] = React.useState<unknown>(null);
  const [wasSuccessful, setWasSuccessful] = React.useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = React.useState(false);
  const transform = React.useRef<TransformCallback<TForm>>((value) => value);
  const isDirty = React.useMemo(() => !isEqual(data, defaults), [data, defaults]);

  React.useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Set when onSuccess calls setDefaults itself, so the automatic update does not override it.
  const setDefaultsCalledInOnSuccess = React.useRef(false);

  const submit = React.useCallback(
    (...submitArgs: SubmitArguments) => {
      const { method, url, options } = parseSubmitArguments(submitArgs);
      setDefaultsCalledInOnSuccess.current = false;

      const visitOptions: VisitOptions = {
        ...options,
        onCancelToken: (token) => {
          cancelToken.current = token;
          return options.onCancelToken?.(token);
        },
        onBefore: (visit) => {
          setWasSuccessful(false);
          setRecentlySuccessful(false);
          clearTimeout(recentlySuccessfulTimeoutId.current);
          return options.onBefore?.(visit);
        },
        onStart: (visit) => {
          setProcessing(true);
          return options.onStart?.(visit);
        },
        onProgress: (event) => {
          setProgress(event || null);
          return options.onProgress?.(event);
        },
        onSuccess: async (page) => {
          if (isMounted.current) {
            setProcessing(false);
            setProgress(null);
            setErrors({} as FormDataErrors<TForm>);
            setHasErrors(false);
            setWasSuccessful(true);
            setRecentlySuccessful(true);
            recentlySuccessfulTimeoutId.current = setTimeout(() => {
              if (isMounted.current) setRecentlySuccessful(false);
            }, RECENTLY_SUCCESSFUL_DURATION_MS);
          }

          const result = options.onSuccess ? await options.onSuccess(page) : null;

          if (isMounted.current && !setDefaultsCalledInOnSuccess.current) {
            setData((current) => {
              setDefaults(cloneDeep(current));
              return current;
            });
          }
          return result;
        },
        onError: (newErrors) => {
          if (isMounted.current) {
            setProcessing(false);
            setProgress(null);
            setErrors(newErrors as FormDataErrors<TForm>);
            setHasErrors(Object.keys(newErrors).length > 0);
          }
          return options.onError?.(newErrors);
        },
        onCancel: () => {
          if (isMounted.current) {
            setProcessing(false);
            setProgress(null);
          }
          return options.onCancel?.();
        },
        onFinish: (visit) => {
          if (isMounted.current) {
            setProcessing(false);
            setProgress(null);
          }
          cancelToken.current = null;
          return options.onFinish?.(visit);
        },
      };

      const transformed = transform.current(data) as RequestPayload;
      if (method === "delete") router.delete(url, { ...visitOptions, data: transformed });
      else router[method](url, transformed, visitOptions);
    },
    [data, setErrors, setData],
  );

  const setDataFunction = React.useCallback(
    (keyOrData: string | ((previous: TForm) => TForm) | Partial<TForm>, maybeValue?: unknown) => {
      if (typeof keyOrData === "string") setData((current) => set(cloneDeep(current), keyOrData, maybeValue));
      else if (typeof keyOrData === "function") setData((current) => keyOrData(current));
      else setData(keyOrData as TForm);
    },
    [setData],
  );

  const [dataAsDefaults, setDataAsDefaults] = React.useState(false);
  const dataRef = React.useRef(data);
  React.useEffect(() => {
    dataRef.current = data;
  });

  const setDefaultsFunction = React.useCallback((fieldOrFields?: string | Partial<TForm>, maybeValue?: unknown) => {
    setDefaultsCalledInOnSuccess.current = true;
    if (typeof fieldOrFields === "undefined") {
      setDefaults(dataRef.current);
      // setData may have been called just before; adopt the data of the next render too.
      setDataAsDefaults(true);
    } else {
      setDefaults((current) =>
        typeof fieldOrFields === "string"
          ? set(cloneDeep(current), fieldOrFields, maybeValue)
          : Object.assign(cloneDeep(current), fieldOrFields),
      );
    }
  }, []);

  const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;
  useIsomorphicLayoutEffect(() => {
    if (!dataAsDefaults) return;
    if (isDirty) setDefaults(data);
    setDataAsDefaults(false);
  }, [dataAsDefaults]);

  const reset = React.useCallback(
    (...fields: string[]) => {
      if (fields.length === 0) {
        setData(defaults);
      } else {
        setData((current) =>
          fields.filter((key) => has(defaults, key)).reduce((carry, key) => set(carry, key, get(defaults, key)), { ...current } as TForm),
        );
      }
    },
    [setData, defaults],
  );

  const setError = React.useCallback(
    (fieldOrFields: string | FormDataErrors<TForm>, maybeValue?: ErrorValue) => {
      setErrors((current) => {
        const next = { ...current, ...(typeof fieldOrFields === "string" ? { [fieldOrFields]: maybeValue } : fieldOrFields) };
        setHasErrors(Object.keys(next).length > 0);
        return next as FormDataErrors<TForm>;
      });
    },
    [setErrors],
  );

  const clearErrors = React.useCallback(
    (...fields: string[]) => {
      setErrors((current) => {
        const next = Object.keys(current).reduce<Record<string, unknown>>(
          (carry, field) => ({
            ...carry,
            ...(fields.length > 0 && !fields.includes(field) ? { [field]: (current as Record<string, unknown>)[field] } : {}),
          }),
          {},
        );
        setHasErrors(Object.keys(next).length > 0);
        return next as FormDataErrors<TForm>;
      });
    },
    [setErrors],
  );

  const resetAndClearErrors = React.useCallback(
    (...fields: string[]) => {
      reset(...fields);
      clearErrors(...fields);
    },
    [reset, clearErrors],
  );

  const createSubmitMethod = (method: Method) => (url: string, options: SubmitOptions = {}) => submit(method, url, options);

  return {
    data,
    setData: setDataFunction as InertiaFormProps<TForm>["setData"],
    isDirty,
    errors,
    hasErrors,
    processing,
    progress,
    wasSuccessful,
    recentlySuccessful,
    transform: (callback) => {
      transform.current = callback;
    },
    setDefaults: setDefaultsFunction as InertiaFormProps<TForm>["setDefaults"],
    reset: reset as InertiaFormProps<TForm>["reset"],
    setError: setError as InertiaFormProps<TForm>["setError"],
    clearErrors: clearErrors as InertiaFormProps<TForm>["clearErrors"],
    resetAndClearErrors: resetAndClearErrors as InertiaFormProps<TForm>["resetAndClearErrors"],
    submit,
    get: createSubmitMethod("get"),
    post: createSubmitMethod("post"),
    put: createSubmitMethod("put"),
    patch: createSubmitMethod("patch"),
    delete: createSubmitMethod("delete"),
    cancel: () => cancelToken.current?.cancel(),
  };
}
