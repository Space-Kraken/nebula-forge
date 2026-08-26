import { Command } from '@oclif/core';
import { ForgeError } from '@forgecli/core';

/** Renders ForgeErrors as clean messages with their fix-it hint. */
export abstract class BaseCommand extends Command {
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (error instanceof ForgeError) {
      this.error(error.hint ? `${error.message}\n${error.hint}` : error.message);
    }
    return super.catch(error);
  }
}
