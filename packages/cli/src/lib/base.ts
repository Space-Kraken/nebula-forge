import { Command } from '@oclif/core';
import { ForgeError, loadWorkspace } from '@forgecli/core';
import type { WorkspaceModel } from '@forgecli/core';

/** Renders ForgeErrors as clean messages with their fix-it hint. */
export abstract class BaseCommand extends Command {
  /** Loads the workspace and surfaces load-time warnings (e.g. convention overrides). */
  protected loadModel(): WorkspaceModel {
    const model = loadWorkspace(process.cwd());
    for (const warning of model.warnings ?? []) {
      this.warn(warning);
    }
    return model;
  }

  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (error instanceof ForgeError) {
      this.error(error.hint ? `${error.message}\n${error.hint}` : error.message);
    }
    return super.catch(error);
  }
}
