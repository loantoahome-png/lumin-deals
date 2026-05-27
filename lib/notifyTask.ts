// Client helper — fire a task email notification (assigned / completed).
// Fire-and-forget: we never block the UI on the email.

import type { DealTask } from './types'

export function notifyTask(event: 'assigned' | 'completed', task: Partial<DealTask>): void {
  // Skip entirely if there's no one to notify
  if (event === 'assigned' && !task.assignee) return
  if (event === 'completed' && !task.assignee && !task.assigned_by) return

  void fetch('/api/tasks/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        due_at: task.due_at,
        assignee: task.assignee,
        assigned_by: task.assigned_by,
        deal_id: task.deal_id,
      },
    }),
  }).catch(e => console.warn('[notifyTask] failed:', e))
}
