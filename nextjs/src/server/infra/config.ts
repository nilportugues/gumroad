// Contract owned by WS-06. Mirrors GlobalConfig.get in Ruby: env first, then credentials.
export function getConfig(name: string): string | undefined {
  return process.env[name];
}

export function getRequiredConfig(name: string): string {
  const value = getConfig(name);
  if (value === undefined || value === "") throw new Error(`Missing config ${name}`);
  return value;
}
