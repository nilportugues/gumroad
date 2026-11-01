// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import { contentModerationAdminCommentJob, detectLegalEntityCountryDriftJob, releaseChargebackRatePayoutPausesJob } from "./comment-jobs.ts";
import { deleteExpiredProductCachedValuesWorker, deleteOldUnusedEventsWorker, deleteProcessedWorkflowInstallmentScheduleIntentsJob } from "./batched-cleanup-jobs.ts";
import { forceFinishLongRunningCommunityChatRecapRunsJob, triggerCommunityChatRecapRunJob } from "./community-chat-recap-jobs.ts";
import { deleteOldPingDeliveriesJob, deleteOldProcessedStripeEventsJob, deleteOldSentEmailInfoRecordsJob } from "./delete-old-records-jobs.ts";
import { deleteOldVersionsRecordsWorker } from "./delete-old-versions-records-worker.ts";
import { dispatchPendingWorkflowInstallmentScheduleIntentsJob } from "./dispatch-workflow-intents-job.ts";
import { elasticsearchIndexerWorker } from "./elasticsearch-indexer-worker.ts";
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { disputeEvidenceDueSoonReminderJob } from "./dispute-evidence-due-soon-reminder-job.ts";
import { sendCommunityChatRecapNotificationsJob } from "./send-community-chat-recap-notifications-job.ts";
import { sendMarketingXReconnectEmailJob } from "./send-marketing-x-reconnect-email-job.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";
import { updateSellerRefundEligibilityJob } from "./update-seller-refund-eligibility-job.ts";
import { handleStripeAutodebitForNegativeBalance } from "./handle-stripe-autodebit-job.ts";
import { recoverAusBacktaxFromStripeAccountJob } from "./recover-aus-backtax-from-stripe-account-job.ts";
import { expireStampedPdfsJob, updateLargeSellersSalesCountJob } from "./large-seller-and-stamped-pdf-jobs.ts";
import { logResendEventJob } from "./log-resend-event-job.ts";
import { logSendgridEventWorker } from "./log-sendgrid-event-worker.ts";
import {
  refreshMerchantAccountProductsRecommendationEligibilityJob,
  refreshUserProductsRecommendationEligibilityJob,
  reindexRecommendableProductsWorker,
  sendToElasticsearchWorker,
} from "./product-search-jobs.ts";
import { backfillMerchantAccountRecommendationEligibilityJob, reindexSubscriptionCurrentEmailWorker } from "./search-reindex-jobs.ts";
import { sellerUpdatesWorker } from "./seller-updates-worker.ts";
import {
  chargeDeclinedReminderWorker,
  findSubscriptionsWithMissingChargeWorker,
  freeTrialExpiringReminderWorker,
  recurringChargeReminderWorker,
  reviewReminderJob,
  sendAutoInvoiceEmailJob,
} from "./subscription-reminder-jobs.ts";
import { endSubscriptionWorker, setSubscriptionAsDeactivatedWorker, unsubscribeAndFailWorker } from "./subscription-write-jobs.ts";
import {
  createStripeApplePayDomainWorker,
  createStripeApplePayDomainWorkerRetriesExhausted,
  deleteStripeApplePayDomainWorker,
  syncStripeBusinessProfileUrlJob,
} from "./stripe-jobs.ts";
import { blockEmailDomainsWorker, blockObjectWorker, unblockObjectWorker } from "./platform-block-jobs.ts";
import { blockSuspendedAccountIpWorker, checkPaymentAddressWorker } from "./risk-jobs.ts";
import { internalNotificationWorker } from "./internal-notification-worker.ts";
import { liftPlatformStripePauseJob, liftPlatformStripePauseJobRetriesExhausted, liftPlatformStripePauseJobRetryIn } from "./lift-platform-stripe-pause-job.ts";
import { alertOnStalledAbandonedCartEmailsJob, buildTaxRateCacheWorker, recoverAusBacktaxesFromStripeAccountsJob } from "./scheduled-check-jobs.ts";
import { suspendAccountsWithPaymentAddressWorker, suspendUsersWorker } from "./suspend-jobs.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import { warmSellerReputationSummaryJob } from "./warm-seller-reputation-summary-job.ts";
import { recalculateRecentWishlistFollowerCountJob } from "./wishlist-jobs.ts";
import {
  createMissingPurchaseEventsWorker,
  expireRentalPurchasesWorker,
  findExpiredSubscriptionsToSetAsDeactivatedWorker,
  sendRentalExpiresSoonEmailWorker,
  syncStuckPurchasesJob,
  updatePurchaseHealthcheckThresholdJob,
} from "./purchase-reads-jobs.ts";
import {
  createMissingDisputeEvidenceJob,
  dispatchPendingFailedRefundExceptionsJob,
  fightDisputesJob,
  notifyFailedRefundExceptionJob,
  recoverPendingRefundFeeRetentionJob,
  refundUnpaidPurchasesWorker,
} from "./refund-dispute-jobs.ts";
import type { RetriesExhausted, RetryIn } from "../retry.ts";
import type { JobHandler } from "./types.ts";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  AlertOnStalledAbandonedCartEmailsJob: alertOnStalledAbandonedCartEmailsJob,
  BackfillMerchantAccountRecommendationEligibilityJob: backfillMerchantAccountRecommendationEligibilityJob,
  BlockEmailDomainsWorker: blockEmailDomainsWorker,
  BlockObjectWorker: blockObjectWorker,
  BlockSuspendedAccountIpWorker: blockSuspendedAccountIpWorker,
  BuildTaxRateCacheWorker: buildTaxRateCacheWorker,
  CheckPaymentAddressWorker: checkPaymentAddressWorker,
  ChargeDeclinedReminderWorker: chargeDeclinedReminderWorker,
  ContentModerationAdminCommentJob: contentModerationAdminCommentJob,
  CreateMissingDisputeEvidenceJob: createMissingDisputeEvidenceJob,
  CreateMissingPurchaseEventsWorker: createMissingPurchaseEventsWorker,
  CreateStripeApplePayDomainWorker: createStripeApplePayDomainWorker,
  DeleteExpiredProductCachedValuesWorker: deleteExpiredProductCachedValuesWorker,
  DeleteOldPingDeliveriesJob: deleteOldPingDeliveriesJob,
  DeleteOldProcessedStripeEventsJob: deleteOldProcessedStripeEventsJob,
  DeleteOldSentEmailInfoRecordsJob: deleteOldSentEmailInfoRecordsJob,
  DeleteOldUnusedEventsWorker: deleteOldUnusedEventsWorker,
  DeleteOldVersionsRecordsWorker: deleteOldVersionsRecordsWorker,
  DeleteProcessedWorkflowInstallmentScheduleIntentsJob: deleteProcessedWorkflowInstallmentScheduleIntentsJob,
  DeleteStripeApplePayDomainWorker: deleteStripeApplePayDomainWorker,
  DetectLegalEntityCountryDriftJob: detectLegalEntityCountryDriftJob,
  DispatchPendingFailedRefundExceptionsJob: dispatchPendingFailedRefundExceptionsJob,
  DispatchPendingWorkflowInstallmentScheduleIntentsJob: dispatchPendingWorkflowInstallmentScheduleIntentsJob,
  DisputeEvidenceDueSoonReminderJob: disputeEvidenceDueSoonReminderJob,
  ElasticsearchIndexerWorker: elasticsearchIndexerWorker,
  ExpireRentalPurchasesWorker: expireRentalPurchasesWorker,
  EnqueueMarketingXReconnectEmailJob: enqueueMarketingXReconnectEmailJob,
  ExpireStampedPdfsJob: expireStampedPdfsJob,
  EndSubscriptionWorker: endSubscriptionWorker,
  FightDisputesJob: fightDisputesJob,
  FindExpiredSubscriptionsToSetAsDeactivatedWorker: findExpiredSubscriptionsToSetAsDeactivatedWorker,
  FindSubscriptionsWithMissingChargeWorker: findSubscriptionsWithMissingChargeWorker,
  FreeTrialExpiringReminderWorker: freeTrialExpiringReminderWorker,
  ForceFinishLongRunningCommunityChatRecapRunsJob: forceFinishLongRunningCommunityChatRecapRunsJob,
  HandleSnsAwsConfigEventWorker: handleSnsAwsConfigEventWorker,
  HandleStripeAutodebitForNegativeBalance: handleStripeAutodebitForNegativeBalance,
  InternalNotificationWorker: internalNotificationWorker,
  LiftPlatformStripePauseJob: liftPlatformStripePauseJob,
  LogResendEventJob: logResendEventJob,
  LogSendgridEventWorker: logSendgridEventWorker,
  NotifyFailedRefundExceptionJob: notifyFailedRefundExceptionJob,
  SellerUpdatesWorker: sellerUpdatesWorker,
  SendToElasticsearchWorker: sendToElasticsearchWorker,
  RecalculateRecentWishlistFollowerCountJob: recalculateRecentWishlistFollowerCountJob,
  RecoverAusBacktaxFromStripeAccountJob: recoverAusBacktaxFromStripeAccountJob,
  RecoverPendingRefundFeeRetentionJob: recoverPendingRefundFeeRetentionJob,
  RecurringChargeReminderWorker: recurringChargeReminderWorker,
  RecoverAusBacktaxesFromStripeAccountsJob: recoverAusBacktaxesFromStripeAccountsJob,
  RefreshMerchantAccountProductsRecommendationEligibilityJob: refreshMerchantAccountProductsRecommendationEligibilityJob,
  RefreshUserProductsRecommendationEligibilityJob: refreshUserProductsRecommendationEligibilityJob,
  RefundUnpaidPurchasesWorker: refundUnpaidPurchasesWorker,
  ReindexRecommendableProductsWorker: reindexRecommendableProductsWorker,
  ReindexSubscriptionCurrentEmailWorker: reindexSubscriptionCurrentEmailWorker,
  ReleaseChargebackRatePayoutPausesJob: releaseChargebackRatePayoutPausesJob,
  ReviewReminderJob: reviewReminderJob,
  SendAutoInvoiceEmailJob: sendAutoInvoiceEmailJob,
  SetSubscriptionAsDeactivatedWorker: setSubscriptionAsDeactivatedWorker,
  SendCommunityChatRecapNotificationsJob: sendCommunityChatRecapNotificationsJob,
  SendMarketingXReconnectEmailJob: sendMarketingXReconnectEmailJob,
  SendRentalExpiresSoonEmailWorker: sendRentalExpiresSoonEmailWorker,
  SuspendAccountsWithPaymentAddressWorker: suspendAccountsWithPaymentAddressWorker,
  SuspendUsersWorker: suspendUsersWorker,
  SyncStripeBusinessProfileUrlJob: syncStripeBusinessProfileUrlJob,
  SyncStripeBusinessProfileUrlWorker: syncStripeBusinessProfileUrlWorker,
  SyncStuckPurchasesJob: syncStuckPurchasesJob,
  TriggerCommunityChatRecapRunJob: triggerCommunityChatRecapRunJob,
  UnsubscribeAndFailWorker: unsubscribeAndFailWorker,
  UnblockObjectWorker: unblockObjectWorker,
  UpdateCurrenciesWorker: updateCurrenciesWorker,
  UpdateLargeSellersSalesCountJob: updateLargeSellersSalesCountJob,
  UpdatePurchaseHealthcheckThresholdJob: updatePurchaseHealthcheckThresholdJob,
  UpdateSellerRefundEligibilityJob: updateSellerRefundEligibilityJob,
  WarmSellerReputationSummaryJob: warmSellerReputationSummaryJob,
};

// `sidekiq_retry_in` and `sidekiq_retries_exhausted` blocks of ported jobs, keyed by Ruby class name.
// The worker refuses to start when a ported job defines one in Ruby and has none here.
export const JOB_RETRY_IN: Record<string, RetryIn> = {
  LiftPlatformStripePauseJob: liftPlatformStripePauseJobRetryIn,
};

export const JOB_RETRIES_EXHAUSTED: Record<string, RetriesExhausted> = {
  CreateStripeApplePayDomainWorker: createStripeApplePayDomainWorkerRetriesExhausted,
  LiftPlatformStripePauseJob: liftPlatformStripePauseJobRetriesExhausted,
};
