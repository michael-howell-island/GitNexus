import { GreetingTypes } from './Types';
import type { IGreeter } from '../IGreeter';
import { Greeter } from '../Greeter';

export class GreetingModule implements BaseModule {
  load(container: Container): void {
    container.bind<IGreeter>(GreetingTypes.IGreeter).to(Greeter).inSingletonScope();
  }
}
