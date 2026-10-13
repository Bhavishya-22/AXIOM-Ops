import { describe, it, expect } from 'vitest';
import { validateOutcomeFields } from '@axiomops/shared';

describe('Outcome Fields Validity Matrix (Section 6)', () => {
  describe('Valid combinations', () => {
    it('accepts incident + diagnosed + single + executable', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: ['redis_unavailable'],
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + diagnosed + single + manual_recommended', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'manual_recommended',
        dispositionReason: 'regulated_service_requires_change_control',
        rootCauses: ['idp_down'],
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + diagnosed + compound + manual_recommended', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'compound',
        actionDisposition: 'manual_recommended',
        dispositionReason: 'compound',
        rootCauses: ['redis_unavailable', 'db_pool_exhausted'],
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + insufficient_evidence + null + no_action', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'insufficient_evidence',
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + ambiguous_multiple_causes + null + no_action', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'ambiguous_multiple_causes',
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + invalid_model_output + null + no_action', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'invalid_model_output',
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(true);
    });

    it('accepts incident + failed + null + no_action', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'failed',
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(true);
    });

    it('accepts not_an_incident + null + null + no_action', () => {
      const res = validateOutcomeFields({
        classification: 'not_an_incident',
        diagnosisStatus: null,
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(true);
    });

    it('accepts service_request + null + null + manual_recommended', () => {
      const res = validateOutcomeFields({
        classification: 'service_request',
        diagnosisStatus: null,
        causeMode: null,
        actionDisposition: 'manual_recommended',
      });
      expect(res.success).toBe(true);
    });

    it('accepts service_request + null + null + executed', () => {
      const res = validateOutcomeFields({
        classification: 'service_request',
        diagnosisStatus: null,
        causeMode: null,
        actionDisposition: 'executed',
      });
      expect(res.success).toBe(true);
    });
  });

  describe('Illegal combinations (must be rejected)', () => {
    it('rejects compound with executable (compound can NEVER be executable)', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'compound',
        actionDisposition: 'executable',
        rootCauses: ['redis_unavailable', 'db_pool_exhausted'],
      });
      expect(res.success).toBe(false);
    });

    it('rejects insufficient_evidence with executable or manual_recommended', () => {
      const res1 = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'insufficient_evidence',
        causeMode: null,
        actionDisposition: 'executable',
      });
      expect(res1.success).toBe(false);

      const res2 = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'insufficient_evidence',
        causeMode: null,
        actionDisposition: 'manual_recommended',
      });
      expect(res2.success).toBe(false);
    });

    it('rejects ambiguous_multiple_causes with executable', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'ambiguous_multiple_causes',
        causeMode: null,
        actionDisposition: 'executable',
      });
      expect(res.success).toBe(false);
    });

    it('rejects insufficient_evidence with non-null causeMode', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'insufficient_evidence',
        causeMode: 'single',
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(false);
    });

    it('rejects not_an_incident with diagnosed status', () => {
      const res = validateOutcomeFields({
        classification: 'not_an_incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(false);
    });

    it('rejects not_an_incident with executable action', () => {
      const res = validateOutcomeFields({
        classification: 'not_an_incident',
        diagnosisStatus: null,
        causeMode: null,
        actionDisposition: 'executable',
      });
      expect(res.success).toBe(false);
    });

    it('rejects service_request with diagnosed status', () => {
      const res = validateOutcomeFields({
        classification: 'service_request',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executed',
      });
      expect(res.success).toBe(false);
    });

    it('rejects service_request with no_action', () => {
      const res = validateOutcomeFields({
        classification: 'service_request',
        diagnosisStatus: null,
        causeMode: null,
        actionDisposition: 'no_action',
      });
      expect(res.success).toBe(false);
    });

    it('rejects incident diagnosed with empty rootCauses', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'executable',
        rootCauses: [],
      });
      expect(res.success).toBe(false);
    });

    it('rejects incident diagnosed single with no_action', () => {
      const res = validateOutcomeFields({
        classification: 'incident',
        diagnosisStatus: 'diagnosed',
        causeMode: 'single',
        actionDisposition: 'no_action',
        rootCauses: ['redis_unavailable'],
      });
      expect(res.success).toBe(false);
    });
  });
});
