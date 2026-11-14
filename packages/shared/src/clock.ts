/** Clock abstraction: all deadline decisions use DB time (PRD §5). */
export interface Clock {
  now(): Promise<Date>;
}

/** Test clock: settable time. Production uses DbClock (in api/worker). */
export class FakeClock implements Clock {
  constructor(private t: Date) {}
  set(t: Date | string | number) { this.t = new Date(t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  async now() { return this.t; }
}
