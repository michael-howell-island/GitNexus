import type { IGreeter } from './IGreeter';

export class Greeter implements IGreeter {
  greet(name: string): string {
    return `hello ${name}`;
  }
}
