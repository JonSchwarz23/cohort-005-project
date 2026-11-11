import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";

// Refund Eligibility — see GLOSSARY.md. The course page and the Refund
// Request action both go through getRefundEligibility, so they can't drift.
export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundIneligibleReason =
  | "no_purchase"
  | "open_refund_request"
  | "outside_refund_window"
  | "watched_too_much"
  | "completed_too_much"
  | "claimed_team_seat";

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      // A Refund is always the full Amount Paid.
      amountPaid: number;
      lastDayInRefundWindow: string;
    }
  | { eligible: false; reason: RefundIneligibleReason };

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

export function getOpenRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

// Sums the furthest point reached in each lesson.
function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function hasClaimedTeamSeat(purchaseId: number) {
  return Boolean(
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
      )
      .get()
  );
}

/**
 * Whether the learner's latest Purchase of this course may receive a Refund
 * Request right now.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  if (!purchase) return { eligible: false, reason: "no_purchase" };

  if (getOpenRefundRequest(purchase.id)) {
    return { eligible: false, reason: "open_refund_request" };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (hasClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "claimed_team_seat" };
  }

  const purchasedDay = calendarDay(new Date(purchase.createdAt));
  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInRefundWindow = calendarDay(windowEnd);
  const today = calendarDay(new Date());

  if (today < purchasedDay || today > lastDayInRefundWindow) {
    return { eligible: false, reason: "outside_refund_window" };
  }

  const lessonIds = getLessonIdsForCourse(courseId);

  if (lessonIds.length > 0) {
    const completedCount = getCompletedLessonCount(userId, lessonIds);
    if (completedCount / lessonIds.length >= REFUND_COMPLETION_LIMIT) {
      return { eligible: false, reason: "completed_too_much" };
    }
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return { eligible: false, reason: "watched_too_much" };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amountPaid: purchase.amountPaid,
    lastDayInRefundWindow,
  };
}
