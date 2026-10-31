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
import { sendMarketingXReconnectEmailJob } from "./send-marketing-x-reconnect-email-job.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";
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
  createStripeApplePayDomainWorker,
  createStripeApplePayDomainWorkerRetriesExhausted,
  deleteStripeApplePayDomainWorker,
  syncStripeBusinessProfileUrlJob,
} from "./stripe-jobs.ts";
import { blockEmailDomainsWorker, blockObjectWorker, unblockObjectWorker } from "./platform-block-jobs.ts";
import { alertOnStalledAbandonedCartEmailsJob, buildTaxRateCacheWorker, recoverAusBacktaxesFromStripeAccountsJob } from "./scheduled-check-jobs.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import { warmSellerReputationSummaryJob } from "./warm-seller-reputation-summary-job.ts";
import { recalculateRecentWishlistFollowerCountJob } from "./wishlist-jobs.ts";
import type { RetriesExhausted, RetryIn } from "../retry.ts";
import type { JobHandler } from "./types.ts";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  AlertOnStalledAbandonedCartEmailsJob: alertOnStalledAbandonedCartEmailsJob,
  BackfillMerchantAccountRecommendationEligibilityJob: backfillMerchantAccountRecommendationEligibilityJob,
  BlockEmailDomainsWorker: blockEmailDomainsWorker,
  BlockObjectWorker: blockObjectWorker,
  BuildTaxRateCacheWorker: buildTaxRateCacheWorker,
  ContentModerationAdminCommentJob: contentModerationAdminCommentJob,
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
  DispatchPendingWorkflowInstallmentScheduleIntentsJob: dispatchPendingWorkflowInstallmentScheduleIntentsJob,
  DisputeEvidenceDueSoonReminderJob: disputeEvidenceDueSoonReminderJob,
  ElasticsearchIndexerWorker: elasticsearchIndexerWorker,
  EnqueueMarketingXReconnectEmailJob: enqueueMarketingXReconnectEmailJob,
  ExpireStampedPdfsJob: expireStampedPdfsJob,
  ForceFinishLongRunningCommunityChatRecapRunsJob: forceFinishLongRunningCommunityChatRecapRunsJob,
  HandleSnsAwsConfigEventWorker: handleSnsAwsConfigEventWorker,
  LogResendEventJob: logResendEventJob,
  LogSendgridEventWorker: logSendgridEventWorker,
  SellerUpdatesWorker: sellerUpdatesWorker,
  SendToElasticsearchWorker: sendToElasticsearchWorker,
  RecalculateRecentWishlistFollowerCountJob: recalculateRecentWishlistFollowerCountJob,
  RecoverAusBacktaxesFromStripeAccountsJob: recoverAusBacktaxesFromStripeAccountsJob,
  RefreshMerchantAccountProductsRecommendationEligibilityJob: refreshMerchantAccountProductsRecommendationEligibilityJob,
  RefreshUserProductsRecommendationEligibilityJob: refreshUserProductsRecommendationEligibilityJob,
  ReindexRecommendableProductsWorker: reindexRecommendableProductsWorker,
  ReindexSubscriptionCurrentEmailWorker: reindexSubscriptionCurrentEmailWorker,
  ReleaseChargebackRatePayoutPausesJob: releaseChargebackRatePayoutPausesJob,
  SendMarketingXReconnectEmailJob: sendMarketingXReconnectEmailJob,
  SyncStripeBusinessProfileUrlJob: syncStripeBusinessProfileUrlJob,
  SyncStripeBusinessProfileUrlWorker: syncStripeBusinessProfileUrlWorker,
  TriggerCommunityChatRecapRunJob: triggerCommunityChatRecapRunJob,
  UnblockObjectWorker: unblockObjectWorker,
  UpdateCurrenciesWorker: updateCurrenciesWorker,
  UpdateLargeSellersSalesCountJob: updateLargeSellersSalesCountJob,
  WarmSellerReputationSummaryJob: warmSellerReputationSummaryJob,
};

// `sidekiq_retry_in` and `sidekiq_retries_exhausted` blocks of ported jobs, keyed by Ruby class name.
// The worker refuses to start when a ported job defines one in Ruby and has none here.
export const JOB_RETRY_IN: Record<string, RetryIn> = {};

export const JOB_RETRIES_EXHAUSTED: Record<string, RetriesExhausted> = {
  CreateStripeApplePayDomainWorker: createStripeApplePayDomainWorkerRetriesExhausted,
};
