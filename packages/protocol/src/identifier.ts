import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Identifier — the shape every identifier in this protocol shares
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The shape every identifier in this protocol shares: a non-empty string of at most 200
 * characters.
 *
 * Task identifiers, device identifiers, frame identifiers, and assignment identifiers are all
 * checked against this one definition, so a length limit is stated once rather than repeated at
 * every place an identifier appears in a message.
 */
export const Identifier = z.string().min(1).max(200);

/** The identifier a consumer gives its own submission, so a repeat submission is recognised. */
export const TaskRequestId = Identifier;

/** The identifier of one stage assignment, which outlives the attempt that carries it. */
export const StageAssignmentId = Identifier;
