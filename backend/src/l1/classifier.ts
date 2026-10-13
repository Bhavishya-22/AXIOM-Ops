import { SEED_RUNBOOKS, Runbook } from './runbooks.js';

export interface TicketClassificationResult {
  ticketType: 'how_to' | 'access_request' | 'known_issue' | 'not_an_incident' | 'incident_report';
  runbook: Runbook | null;
  explanation: string | null;
  isNotAnIncident: boolean;
}

export function classifyTicket(
  title: string,
  description: string = '',
  services: string[] = []
): TicketClassificationResult {
  const combined = `${title} ${description}`.toLowerCase();

  // 1. Expected business outcomes: Declines
  if (
    /decline|card_declined|do not honor|insufficient funds|payment_declined/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.payment_decline_explanation;
    return {
      ticketType: 'not_an_incident',
      runbook: rb,
      explanation: rb.explanation || 'Payment decline is an expected commercial business outcome, not an infrastructure defect.',
      isNotAnIncident: true,
    };
  }

  // 2. Expected business outcomes: Token Expiry
  if (
    /expired token|token expired|jwt expired|session expired|refresh token/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.expired_token_explanation;
    return {
      ticketType: 'not_an_incident',
      runbook: rb,
      explanation: rb.explanation || 'Token expiry is a standard session lifecycle policy event.',
      isNotAnIncident: true,
    };
  }

  // 3. Access request: Session Reset
  if (
    /reset.*session|session.*reset|invalidate session|locked session|clear session/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.reset_user_session;
    return {
      ticketType: 'access_request',
      runbook: rb,
      explanation: 'Eligible for automated self-service session reset with identity challenge verification.',
      isNotAnIncident: false,
    };
  }

  // 4. Access request: General / MFA
  if (
    /mfa|authenticator|2fa|otp device/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.how_to_verify_mfa_device;
    return {
      ticketType: 'how_to',
      runbook: rb,
      explanation: 'Standard MFA setup procedure.',
      isNotAnIncident: false,
    };
  }

  // 5. How-tos: Browser cache
  if (
    /clear.*cache|browser.*cache|hard refresh|stale cookies/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.how_to_clear_browser_cache;
    return {
      ticketType: 'how_to',
      runbook: rb,
      explanation: 'Client browser state remediation guide.',
      isNotAnIncident: false,
    };
  }

  // 6. How-tos: Payment method update
  if (
    /update.*payment|change.*card|billing portal|add.*payment/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.how_to_update_payment_method;
    return {
      ticketType: 'how_to',
      runbook: rb,
      explanation: 'Customer payment method update guide.',
      isNotAnIncident: false,
    };
  }

  // 7. Known Issues: Maintenance window
  if (
    /maintenance|scheduled window|routine db upgrade/i.test(combined)
  ) {
    const rb = SEED_RUNBOOKS.known_issue_scheduled_maintenance;
    return {
      ticketType: 'known_issue',
      runbook: rb,
      explanation: 'Documented scheduled maintenance window.',
      isNotAnIncident: false,
    };
  }

  // Default to incident_report
  return {
    ticketType: 'incident_report',
    runbook: null,
    explanation: null,
    isNotAnIncident: false,
  };
}
