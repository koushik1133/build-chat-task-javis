/** Shape every proactive playbook implements. */
export interface PlaybookDef {
  id: string;
  name: string;
  description: string;
  /** Event types that make this playbook worth re-checking early. */
  eventTypes?: string[];
  /** Don't re-run for the same (user, entity) within this many hours. */
  cooldownHours: number;
  /** Entity ids that currently need action for this user. */
  detect(userId: string): Promise<string[]>;
  /** Full prompt handed to the playbook agent for one entity. */
  buildPrompt(userId: string, entityId: string): Promise<string>;
  /** Tools the dedicated playbook agent is allowed to call. */
  defaultTools: string[];
}
