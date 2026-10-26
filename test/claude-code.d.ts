// The engine writes the real types next to a loaded plugin; core's type check only needs this much
// to follow test/timer.spec.ts into timer/hooks/register.ts.
declare module "claude-code" {
  type Hook = ($: any, e: any, next: (e: any) => Promise<any>) => unknown;
  type On = { (event: string, hook: Hook): void; (event: string, matcher: object, hook: Hook): void };
  export type Register = (on: On, options?: Record<string, unknown>) => void;
}
