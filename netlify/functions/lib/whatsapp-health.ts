// Turns Meta's account-health webhook fields into something worth emailing.
// Pure (no I/O) so it can be tested; whatsapp-webhook.mts does the storing and
// emailing. Fields it doesn't recognise return null and are only logged.
//
// Fields (WhatsApp Manager > the app > WhatsApp > Configuration > Webhook
// fields must be subscribed to each): message_template_status_update,
// message_template_quality_update, phone_number_quality_update,
// template_category_update, account_update, account_alerts.
import { createHash } from 'node:crypto';

export type HealthSeverity = 'info' | 'warning' | 'critical';
export interface HealthEvent {
  severity: HealthSeverity;
  title: string;
  detail: string | null;
}

function clean(value: unknown, max = 300): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function join(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter((p) => p && p.trim()).join(' · ');
  return text || null;
}

const QUALITY_SEVERITY: Record<string, HealthSeverity | undefined> = { RED: 'critical', YELLOW: 'warning', GREEN: 'info' };

export function classifyHealthEvent(field: string, value: any): HealthEvent | null {
  if (!value || typeof value !== 'object') return null;

  switch (field) {
    case 'message_template_status_update': {
      const event = clean(value.event).toUpperCase();
      const name = clean(value.message_template_name) || 'a template';
      const reason = clean(value.reason);
      const detail = join([reason && reason.toUpperCase() !== 'NONE' ? reason : null, value.disable_info?.disable_date ? `disabled ${clean(value.disable_info.disable_date)}` : null]);
      const bySeverity: Record<string, [HealthSeverity, string]> = {
        APPROVED: ['info', 'approved'],
        REINSTATED: ['info', 'reinstated'],
        REJECTED: ['warning', 'rejected'],
        FLAGGED: ['warning', 'flagged'],
        PAUSED: ['critical', 'paused'],
        DISABLED: ['critical', 'disabled'],
      };
      const hit = bySeverity[event];
      return hit ? { severity: hit[0], title: `Template ${hit[1]}: ${name}`, detail } : null;
    }

    case 'message_template_quality_update': {
      const next = clean(value.new_quality_score).toUpperCase();
      const severity = QUALITY_SEVERITY[next];
      if (!severity) return null;
      return {
        severity,
        title: `Template quality ${next.toLowerCase()}: ${clean(value.message_template_name) || 'a template'}`,
        detail: join([value.previous_quality_score ? `was ${clean(value.previous_quality_score).toLowerCase()}` : null]),
      };
    }

    case 'phone_number_quality_update': {
      const event = clean(value.event).toUpperCase();
      const number = clean(value.display_phone_number);
      const detail = join([number, value.current_limit ? `messaging limit ${clean(value.current_limit)}` : null]);
      const bySeverity: Record<string, [HealthSeverity, string]> = {
        FLAGGED: ['critical', 'Phone number flagged'],
        DOWNGRADE: ['warning', 'Messaging limit lowered'],
        UNFLAGGED: ['info', 'Phone number no longer flagged'],
        UPGRADE: ['info', 'Messaging limit raised'],
      };
      const hit = bySeverity[event];
      return hit ? { severity: hit[0], title: hit[1], detail } : null;
    }

    case 'template_category_update': {
      const next = clean(value.new_category).toUpperCase();
      if (!next) return null;
      return {
        // Marketing costs more per message and needs opt-in, so it matters.
        severity: next === 'MARKETING' ? 'warning' : 'info',
        title: `Template recategorised to ${next.toLowerCase()}: ${clean(value.message_template_name) || 'a template'}`,
        detail: join([value.previous_category ? `was ${clean(value.previous_category).toLowerCase()}` : null]),
      };
    }

    case 'account_update': {
      const event = clean(value.event).toUpperCase();
      if (!event) return null;
      const bad = /VIOLATION|DISABLED|RESTRICT|BAN|DELETED/.test(event);
      return {
        severity: bad ? 'critical' : 'info',
        title: `WhatsApp account: ${event.toLowerCase().replace(/_/g, ' ')}`,
        detail: join([clean(value.phone_number), clean(value.violation_info?.violation_type), clean(value.restriction_info?.[0]?.restriction_type), clean(value.ban_info?.waba_ban_state)]),
      };
    }

    case 'account_alerts': {
      const level = clean(value.alert_severity).toUpperCase();
      return {
        severity: level === 'CRITICAL' ? 'critical' : level === 'WARNING' ? 'warning' : 'info',
        title: `WhatsApp alert: ${clean(value.alert_type).toLowerCase().replace(/_/g, ' ') || 'account alert'}`,
        detail: join([clean(value.alert_description), clean(value.alert_status)]),
      };
    }

    default:
      return null;
  }
}

// Stable id for one webhook delivery, so a retried delivery is recognised.
export function healthEventKey(entry: any, field: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([entry?.id ?? null, entry?.time ?? null, field, value])).digest('hex');
}
