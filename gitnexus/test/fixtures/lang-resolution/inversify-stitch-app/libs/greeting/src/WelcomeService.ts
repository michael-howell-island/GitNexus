import type { IGreeter } from './IGreeter';

export class WelcomeService {
  constructor(private readonly greeter: IGreeter) {}

  welcome(name: string): string {
    return this.greeter.greet(name);
  }
}
