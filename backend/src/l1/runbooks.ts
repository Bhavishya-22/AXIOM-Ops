export interface Runbook {
  id: string;
  title: string;
  type: 'how_to' | 'access_request' | 'known_issue' | 'decline_explanation' | 'token_explanation';
  content: string;
  actionId?: string;
  automaticResolution: boolean;
  explanation?: string;
}

export const SEED_RUNBOOKS: Record<string, Runbook> = {
  how_to_clear_browser_cache: {
    id: 'how_to_clear_browser_cache',
    title: 'How to Clear Browser Cache & Client State',
    type: 'how_to',
    content: '1. Open browser settings > Privacy and Security.\n2. Select "Clear browsing data".\n3. Choose "Cached images and files" and "Cookies".\n4. Select "All time" and click "Clear data".\n5. Reload checkout.axiomops.internal.',
    automaticResolution: false,
  },
  how_to_update_payment_method: {
    id: 'how_to_update_payment_method',
    title: 'How to Update Customer Payment Method',
    type: 'how_to',
    content: '1. Navigate to customer billing portal.\n2. Click "Payment Methods" > "Add New Card".\n3. Enter valid card details with 3D Secure verification.\n4. Set as default payment method for recurring transactions.',
    automaticResolution: false,
  },
  how_to_verify_mfa_device: {
    id: 'how_to_verify_mfa_device',
    title: 'How to Verify and Re-register MFA Device',
    type: 'how_to',
    content: '1. Visit identity.axiomops.internal/mfa-setup.\n2. Scan the provided QR code in your Authenticator app.\n3. Enter the 6-digit confirmation code.\n4. Save backup recovery codes securely.',
    automaticResolution: false,
  },
  reset_user_session: {
    id: 'reset_user_session',
    title: 'Self-Service User Session Invalidation and Reset',
    type: 'access_request',
    content: 'Automated self-service session invalidation requiring simulated one-time-code identity challenge proof.',
    actionId: 'reset_user_session',
    automaticResolution: true, // Automatable via identity proof
  },
  known_issue_scheduled_maintenance: {
    id: 'known_issue_scheduled_maintenance',
    title: 'Known Issue: Scheduled Database Maintenance Window',
    type: 'known_issue',
    content: 'Database maintenance window is active for orders-db between 02:00 and 03:00 UTC. Transient read-only states may occur. No manual action is required; systems will resume normal throughput upon completion.',
    automaticResolution: false,
  },
  payment_decline_explanation: {
    id: 'payment_decline_explanation',
    title: 'Expected Business Outcome: Card Issuer Payment Decline',
    type: 'decline_explanation',
    content: 'The observed payment failure is an expected business outcome resulting from card issuer decline (insufficient funds / do not honor), not an infrastructure outage. No system defect detected.',
    automaticResolution: true,
    explanation: 'Card decline rate matches normal commercial card refusal baseline. Not an incident.',
  },
  expired_token_explanation: {
    id: 'expired_token_explanation',
    title: 'Expected Business Outcome: Expired OAuth Session Token',
    type: 'token_explanation',
    content: 'Token expirations reflect standard session timeout policies (refresh token TTL 24 hours). The client should prompt the user to re-authenticate or refresh their credentials.',
    automaticResolution: true,
    explanation: 'Standard token expiry lifecycle event. Not an incident.',
  },
};
