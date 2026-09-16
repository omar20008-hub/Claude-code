import { z } from 'zod';
import { META_PLACEMENTS } from '@/server/agents/contracts';

/**
 * Campaign draft validation.
 *
 * Lives here rather than in the route module because a Next.js Route Handler may
 * only export HTTP method handlers and a fixed set of config fields — exporting
 * a schema from `route.ts` fails the build. Two routes share it, so it needs a
 * home of its own regardless.
 *
 * The constraints mirror what the n8n workflow's own validator enforces, so a
 * user is told about a problem at the API boundary rather than discovering it
 * from an Arabic error raised inside a Code node three services away.
 */
export const campaignDraftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  brief: z.string().max(4000).optional(),
  primaryText: z.string().max(2000).optional(),
  headline: z.string().max(255).optional(),
  description: z.string().max(500).optional(),
  // https only: an ad's destination is a place we send real traffic and real
  // money, and a plaintext link would leak the referrer.
  destinationUrl: z.string().url().startsWith('https://').optional(),
  callToAction: z.string().max(60).optional(),
  placement: z.enum(META_PLACEMENTS).optional(),
  savedAudienceId: z.string().max(64).optional(),
  savedAudienceName: z.string().max(200).optional(),
  audienceNotes: z.string().max(1000).optional(),
  ageMin: z.number().int().min(13).max(65).optional(),
  ageMax: z.number().int().min(13).max(65).optional(),
  genders: z.enum(['all', 'male', 'female']).optional(),
  countries: z.array(z.string().length(2)).max(50).optional(),
  cities: z.array(z.string().max(120)).max(100).optional(),
  /** Major units as typed by the user; the service converts to minor units once. */
  lifetimeBudget: z.number().positive().max(10_000_000).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  assetId: z.string().uuid().optional(),
});

export type CampaignDraftInput = z.infer<typeof campaignDraftSchema>;
