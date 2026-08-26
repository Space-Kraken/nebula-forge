import { app } from '@azure/functions';
import type { EventGridEvent, InvocationContext, Timer } from '@azure/functions';
import { RunTaskUC } from './application/run-task.uc';

const useCase = new RunTaskUC();

/**
 * {{module}}/{{name}} — driving adapters (hexagonal). Wiring only: forge
 * subscribes this function to Event Grid (config.subscriptions) and sets
 * TIMER_SCHEDULE when config.schedule is declared. Business logic lives in
 * src/application. fusion-azure will slot in here once it is available.
 */
app.eventGrid('{{name}}', {
  handler: async (event: EventGridEvent, _context: InvocationContext) => {
    await useCase.execute({ source: event.subject ?? '', type: event.eventType, data: event.data });
  },
});

if (process.env.TIMER_SCHEDULE) {
  app.timer('{{name}}-timer', {
    schedule: '%TIMER_SCHEDULE%',
    handler: async (_timer: Timer, _context: InvocationContext) => {
      await useCase.execute({ source: 'timer', type: 'schedule', data: null });
    },
  });
}
