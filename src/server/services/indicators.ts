import type { Indicator } from "../../shared/shared-types.js";
import { getHandler } from "../server-types.js";
import { type ServerContext, type ServiceResult, now } from "../context.js";

export async function setIndicator(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    const indicator: Indicator = {
        participantId,
        conversationId,
        createdAt: now(),
    };
    // Consumer's onCreateIndicator enforces participation atomically and upserts on existing
    await getHandler(ctx.handlers, "createIndicator")(indicator);
    await ctx.subscriptions.broadcastIndicators(conversationId);
    return { result: undefined, hooks: [] };
}

export async function removeIndicator(ctx: ServerContext, participantId: string, conversationId: string): Promise<ServiceResult<void>> {
    // Single bulk DELETE for the (conversationId, participantId) pair, a concurrent setIndicator may slip through but TTL cleanup catches it
    await getHandler(ctx.handlers, "deleteIndicator")(conversationId, participantId);
    await ctx.subscriptions.broadcastIndicators(conversationId);
    return { result: undefined, hooks: [] };
}
