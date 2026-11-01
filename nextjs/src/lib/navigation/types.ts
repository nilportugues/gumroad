// Type surface of @inertiajs/core 2.3.13 that the pages compile against, trimmed to what they use.
// The recursive form-key types are copied as-is (MIT) so `setData("user.email", ...)` keeps type-checking.

export type ErrorValue = string;
export type Errors = Record<string, ErrorValue>;

export type FormDataConvertibleValue = Blob | FormDataEntryValue | Date | boolean | number | null | undefined;
export type FormDataConvertible =
  | Array<FormDataConvertible>
  | { [key: string]: FormDataConvertible }
  | FormDataConvertibleValue;

export type FormDataType<T extends object> = {
  [K in keyof T]: T[K] extends infer U
    ? U extends FormDataConvertibleValue
      ? U
      : U extends (...args: unknown[]) => unknown
        ? never
        : U extends object | Array<unknown>
          ? FormDataType<U>
          : never
    : never;
};

export type FormDataKeys<T> = T extends Function | FormDataConvertibleValue // eslint-disable-line @typescript-eslint/no-unsafe-function-type
  ? never
  : T extends unknown[]
    ? ArrayFormDataKeys<T>
    : T extends object
      ? ObjectFormDataKeys<T>
      : never;

type ArrayFormDataKeys<T extends unknown[]> = number extends T["length"]
  ?
      | `${number}`
      | (0 extends 1 & T[number]
          ? never
          : T[number] extends FormDataConvertibleValue
            ? never
            : `${number}.${FormDataKeys<T[number]>}`)
  :
      | Extract<keyof T, `${number}`>
      | {
          [Key in Extract<keyof T, `${number}`>]: 0 extends 1 & T[Key]
            ? never
            : T[Key] extends FormDataConvertibleValue
              ? never
              : `${Key & string}.${FormDataKeys<T[Key & string] & string>}`;
        }[Extract<keyof T, `${number}`>];

type ObjectFormDataKeys<T extends object> = string extends keyof T
  ? string
  :
      | Extract<keyof T, string>
      | {
          [Key in Extract<keyof T, string>]: 0 extends 1 & T[Key]
            ? never
            : T[Key] extends FormDataConvertibleValue
              ? never
              : T[Key] extends unknown[]
                ? `${Key}.${FormDataKeys<T[Key]> & string}`
                : T[Key] extends Record<string, unknown>
                  ? `${Key}.${FormDataKeys<T[Key]> & string}`
                  : Exclude<T[Key], null | undefined> extends unknown[]
                    ? never
                    : Exclude<T[Key], null | undefined> extends Record<string, unknown>
                      ? `${Key}.${FormDataKeys<Exclude<T[Key], null | undefined>> & string}`
                      : never;
        }[Extract<keyof T, string>];

export type FormDataError<T> = Partial<Record<FormDataKeys<T>, ErrorValue>>;

type PartialFormDataErrors<T> = {
  [K in string extends keyof T ? string : Extract<keyof FormDataError<T>, string>]?: ErrorValue;
};

export type FormDataErrors<T> = PartialFormDataErrors<T> & {
  [K in keyof PartialFormDataErrors<T>]: NonNullable<PartialFormDataErrors<T>[K]>;
};

export type FormDataValues<T, K extends FormDataKeys<T>> = K extends `${infer P}.${infer Rest}`
  ? T extends unknown[]
    ? P extends `${infer I extends number}`
      ? Rest extends FormDataKeys<T[I]>
        ? FormDataValues<T[I], Rest>
        : never
      : never
    : P extends keyof T
      ? Rest extends FormDataKeys<T[P]>
        ? FormDataValues<T[P], Rest>
        : never
      : never
  : K extends keyof T
    ? T[K]
    : T extends unknown[]
      ? T[K & number]
      : never;

export type Method = "get" | "post" | "put" | "patch" | "delete";
export type RequestPayload = Record<string, FormDataConvertible> | FormData;

export interface PageProps {
  [key: string]: unknown;
}

export interface Page<SharedProps extends PageProps = PageProps> {
  component: string;
  props: PageProps & SharedProps & { errors: Errors };
  url: string;
  version: string | null;
  // Set by inertia_rails on a response: which top-level props a partial reload appends to, prepends to
  // or deep-merges into what the page already holds, and the key that identifies a list item.
  mergeProps?: string[];
  prependProps?: string[];
  deepMergeProps?: string[];
  matchPropsOn?: string[];
  // Pagination state of each scroll prop (`InertiaRails.scroll`), which <InfiniteScroll> reads.
  scrollProps?: Record<string, ScrollPropMetadata>;
}

export type ScrollPropMetadata = { pageName: string; previousPage: unknown; nextPage: unknown; currentPage: unknown; reset: boolean };

export type PreserveStateOption = boolean | "errors" | ((page: Page) => boolean);
export type LinkPrefetchOption = "mount" | "hover" | "click";
export type CacheForOption = number | string;

export type Visit<T extends RequestPayload = RequestPayload> = {
  method: Method;
  data: T;
  replace: boolean;
  preserveScroll: PreserveStateOption;
  preserveState: PreserveStateOption;
  only: string[];
  except: string[];
  headers: Record<string, string>;
  errorBag: string | null;
  forceFormData: boolean;
  async: boolean;
  showProgress: boolean;
  prefetch: boolean;
  reset: string[];
  preserveUrl: boolean;
};

export type PendingVisit<T extends RequestPayload = RequestPayload> = Visit<T> & { url: URL };
export type ActiveVisit<T extends RequestPayload = RequestPayload> = PendingVisit<T> & { completed: boolean; cancelled: boolean; interrupted: boolean };

export type VisitCallbacks = {
  onBefore?: (visit: PendingVisit) => boolean | void;
  onStart?: (visit: PendingVisit) => void;
  onProgress?: (progress: unknown) => void;
  onCancelToken?: (token: { cancel: () => void }) => void;
  onCancel?: () => void;
  // Called with the response page before it is applied (partial reloads).
  onBeforeUpdate?: (page: Page) => void;
  onSuccess?: (page: Page) => void | Promise<unknown>;
  onError?: (errors: Errors) => void;
  onFinish?: (visit: ActiveVisit) => void;
};

export type VisitOptions<T extends RequestPayload = RequestPayload> = Partial<Visit<T>> & VisitCallbacks;
export type ReloadOptions = Omit<VisitOptions, "preserveScroll" | "preserveState">;

export type GlobalEventNames = "before" | "start" | "progress" | "finish" | "cancel" | "navigate" | "success" | "error" | "invalid" | "exception";
export type GlobalEvent = CustomEvent<{ visit: PendingVisit; page?: Page; errors?: Errors; response?: Response }>;
