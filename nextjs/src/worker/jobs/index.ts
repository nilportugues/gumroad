// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import type { RetriesExhausted, RetryIn } from "../retry.ts";

import {
  deleteExpiredProductCachedValuesWorker,
  deleteOldUnusedEventsWorker,
  deleteProcessedWorkflowInstallmentScheduleIntentsJob,
} from "./batched-cleanup-jobs.ts";
import {
  contentModerationAdminCommentJob,
  detectLegalEntityCountryDriftJob,
  releaseChargebackRatePayoutPausesJob,
} from "./comment-jobs.ts";
import {
  forceFinishLongRunningCommunityChatRecapRunsJob,
  triggerCommunityChatRecapRunJob,
} from "./community-chat-recap-jobs.ts";
import { backfillTaggingsCountOnTagsJob } from "./backfill-taggings-count-on-tags-job.ts";
import { deleteExpiredOauthDeviceAuthorizationsJob } from "./delete-expired-oauth-device-authorizations-job.ts";
import {
  deleteOldPingDeliveriesJob,
  deleteOldProcessedStripeEventsJob,
  deleteOldSentEmailInfoRecordsJob,
} from "./delete-old-records-jobs.ts";
import { deleteOldVersionsRecordsWorker } from "./delete-old-versions-records-worker.ts";
import { deleteProductFilesArchivesWorker } from "./delete-product-files-archives-worker.ts";
import { deleteWishlistProductsJob } from "./delete-wishlist-products-job.ts";
import { dispatchPendingWorkflowInstallmentScheduleIntentsJob } from "./dispatch-workflow-intents-job.ts";
import { disputeEvidenceDueSoonReminderJob } from "./dispute-evidence-due-soon-reminder-job.ts";
import { elasticsearchIndexerWorker } from "./elasticsearch-indexer-worker.ts";
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { flushDeliveredEmailInfosJob } from "./flush-delivered-email-infos-job.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";
import { handleStripeAutodebitForNegativeBalance } from "./handle-stripe-autodebit-job.ts";
import { internalNotificationWorker } from "./internal-notification-worker.ts";
import { expireStampedPdfsJob, updateLargeSellersSalesCountJob } from "./large-seller-and-stamped-pdf-jobs.ts";
import {
  liftPlatformStripePauseJob,
  liftPlatformStripePauseJobRetriesExhausted,
  liftPlatformStripePauseJobRetryIn,
} from "./lift-platform-stripe-pause-job.ts";
import { logResendEventJob } from "./log-resend-event-job.ts";
import { logSendgridEventWorker } from "./log-sendgrid-event-worker.ts";
import {
  executeScheduledPayoutsJob,
  failAbandonedPurchaseWorker,
  handlePayoutReversedWorker,
  handleStripeEventWorker,
  largeSellersUpdateUserBalanceStatsCacheWorker,
  lowBalanceFraudCheckWorker,
  syncStuckPayoutsJob,
  updatePayoutStatusWorker,
} from "./payment-processor-jobs.ts";
import { blockEmailDomainsWorker, blockObjectWorker, unblockObjectWorker } from "./platform-block-jobs.ts";
import {
  refreshMerchantAccountProductsRecommendationEligibilityJob,
  refreshUserProductsRecommendationEligibilityJob,
  reindexRecommendableProductsWorker,
  sendToElasticsearchWorker,
} from "./product-search-jobs.ts";
import { publishScheduledPostJob } from "./publish-scheduled-post-job.ts";
import {
  createMissingPurchaseEventsWorker,
  expireRentalPurchasesWorker,
  findExpiredSubscriptionsToSetAsDeactivatedWorker,
  sendRentalExpiresSoonEmailWorker,
  syncStuckPurchasesJob,
  updatePurchaseHealthcheckThresholdJob,
} from "./purchase-reads-jobs.ts";
import { recoverAusBacktaxFromStripeAccountJob } from "./recover-aus-backtax-from-stripe-account-job.ts";
import {
  createMissingDisputeEvidenceJob,
  dispatchPendingFailedRefundExceptionsJob,
  fightDisputesJob,
  notifyFailedRefundExceptionJob,
  recoverPendingRefundFeeRetentionJob,
  refundUnpaidPurchasesWorker,
} from "./refund-dispute-jobs.ts";
import {
  fightDisputeJob,
  payoutUsersWorker,
  refundPurchaseWorker,
  updateUserBalanceStatsCacheWorker,
} from "./refund-payout-guard-jobs.ts";
import { removeSuspendedAccountFollowsWorker } from "./remove-suspended-account-follows-worker.ts";
import { blockSuspendedAccountIpWorker, checkPaymentAddressWorker } from "./risk-jobs.ts";
import { scheduleWorkflowInstallmentJob } from "./schedule-workflow-installment-job.ts";
import {
  alertOnStalledAbandonedCartEmailsJob,
  buildTaxRateCacheWorker,
  recoverAusBacktaxesFromStripeAccountsJob,
} from "./scheduled-check-jobs.ts";
import {
  backfillMerchantAccountRecommendationEligibilityJob,
  reindexSubscriptionCurrentEmailWorker,
} from "./search-reindex-jobs.ts";
import { sellerUpdatesWorker } from "./seller-updates-worker.ts";
import { sendCommunityChatRecapNotificationsJob } from "./send-community-chat-recap-notifications-job.ts";
import { sendLastPostJob } from "./send-last-post-job.ts";
import { sendMarketingXReconnectEmailJob } from "./send-marketing-x-reconnect-email-job.ts";
import { sendPurchaseReceiptJob } from "./send-purchase-receipt-job.ts";
import { sendWorkflowInstallmentWorker } from "./send-workflow-installment-worker.ts";
import {
  createStripeApplePayDomainWorker,
  createStripeApplePayDomainWorkerRetriesExhausted,
  deleteStripeApplePayDomainWorker,
  syncStripeBusinessProfileUrlJob,
} from "./stripe-jobs.ts";
import {
  chargeDeclinedReminderWorker,
  findSubscriptionsWithMissingChargeWorker,
  freeTrialExpiringReminderWorker,
  recurringChargeReminderWorker,
  reviewReminderJob,
  sendAutoInvoiceEmailJob,
} from "./subscription-reminder-jobs.ts";
import {
  endSubscriptionWorker,
  setSubscriptionAsDeactivatedWorker,
  unsubscribeAndFailWorker,
} from "./subscription-write-jobs.ts";
import { suspendAccountsWithPaymentAddressWorker, suspendUsersWorker } from "./suspend-jobs.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import type { JobHandler } from "./types.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import { updatePurchasingPowerParityFactorsWorker } from "./update-purchasing-power-parity-factors-worker.ts";
import { updateSellerRefundEligibilityJob } from "./update-seller-refund-eligibility-job.ts";
import { updateUtmLinkStatsJob } from "./update-utm-link-stats-job.ts";
import { warmSellerReputationSummaryJob } from "./warm-seller-reputation-summary-job.ts";
import { recalculateRecentWishlistFollowerCountJob } from "./wishlist-jobs.ts";
import {
  flushInstallmentDeliveredDeltasJob,
  scheduleAffiliateWorkflowJobsJob,
  scheduleWorkflowEmailsWorker,
  sendWorkflowInstallmentRescheduleJob,
  updateInstallmentEventsCountCacheWorker,
} from "./workflow-jobs.ts";

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
  FlushInstallmentDeliveredDeltasJob: flushInstallmentDeliveredDeltasJob,
  ScheduleAffiliateWorkflowJobsJob: scheduleAffiliateWorkflowJobsJob,
  ScheduleWorkflowEmailsWorker: scheduleWorkflowEmailsWorker,
  ScheduleWorkflowInstallmentJob: scheduleWorkflowInstallmentJob,
  SendWorkflowInstallmentRescheduleJob: sendWorkflowInstallmentRescheduleJob,
  SendWorkflowInstallmentWorker: sendWorkflowInstallmentWorker,
  SendLastPostJob: sendLastPostJob,
  PublishScheduledPostJob: publishScheduledPostJob,
  UpdateInstallmentEventsCountCacheWorker: updateInstallmentEventsCountCacheWorker,
  DisputeEvidenceDueSoonReminderJob: disputeEvidenceDueSoonReminderJob,
  ElasticsearchIndexerWorker: elasticsearchIndexerWorker,
  ExpireRentalPurchasesWorker: expireRentalPurchasesWorker,
  EnqueueMarketingXReconnectEmailJob: enqueueMarketingXReconnectEmailJob,
  ExpireStampedPdfsJob: expireStampedPdfsJob,
  EndSubscriptionWorker: endSubscriptionWorker,
  FightDisputesJob: fightDisputesJob,
  ExecuteScheduledPayoutsJob: executeScheduledPayoutsJob,
  FailAbandonedPurchaseWorker: failAbandonedPurchaseWorker,
  HandlePayoutReversedWorker: handlePayoutReversedWorker,
  HandleStripeEventWorker: handleStripeEventWorker,
  LargeSellersUpdateUserBalanceStatsCacheWorker: largeSellersUpdateUserBalanceStatsCacheWorker,
  LowBalanceFraudCheckWorker: lowBalanceFraudCheckWorker,
  SyncStuckPayoutsJob: syncStuckPayoutsJob,
  UpdatePayoutStatusWorker: updatePayoutStatusWorker,
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
  RefreshMerchantAccountProductsRecommendationEligibilityJob:
    refreshMerchantAccountProductsRecommendationEligibilityJob,
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
  SendPurchaseReceiptJob: sendPurchaseReceiptJob,
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
  UpdatePurchasingPowerParityFactorsWorker: updatePurchasingPowerParityFactorsWorker,
  UpdateSellerRefundEligibilityJob: updateSellerRefundEligibilityJob,
  UpdateUtmLinkStatsJob: updateUtmLinkStatsJob,
  WarmSellerReputationSummaryJob: warmSellerReputationSummaryJob,
  FightDisputeJob: fightDisputeJob,
  PayoutUsersWorker: payoutUsersWorker,
  DeleteWishlistProductsJob: deleteWishlistProductsJob,
  DeleteExpiredOauthDeviceAuthorizationsJob: deleteExpiredOauthDeviceAuthorizationsJob,
  FlushDeliveredEmailInfosJob: flushDeliveredEmailInfosJob,
  DeleteProductFilesArchivesWorker: deleteProductFilesArchivesWorker,
  RemoveSuspendedAccountFollowsWorker: removeSuspendedAccountFollowsWorker,
  RefundPurchaseWorker: refundPurchaseWorker,
  UpdateUserBalanceStatsCacheWorker: updateUserBalanceStatsCacheWorker,
  BackfillTaggingsCountOnTagsJob: backfillTaggingsCountOnTagsJob,
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
