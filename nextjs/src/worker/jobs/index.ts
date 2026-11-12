// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import type { RetriesExhausted, RetryIn } from "../retry.ts";

import { alertOnRetiredManagedAccountActivityJob } from "./alert-on-retired-managed-account-activity-job.ts";
import { alertOnZeroBuyerCurrencyWalletPurchasesJob } from "./alert-on-zero-buyer-currency-wallet-purchases-job.ts";
import { backfillOrphanedShownProductsInProfileSectionsJob } from "./backfill-orphaned-shown-products-in-profile-sections-job.ts";
import { backfillPriceCheckerIndexFieldsJob } from "./backfill-price-checker-index-fields-job.ts";
import { backfillTaggingsCountOnTagsJob } from "./backfill-taggings-count-on-tags-job.ts";
import {
  deleteExpiredProductCachedValuesWorker,
  deleteOldUnusedEventsWorker,
  deleteProcessedWorkflowInstallmentScheduleIntentsJob,
} from "./batched-cleanup-jobs.ts";
import { cacheProductDataWorker } from "./cache-product-data-worker.ts";
import { calculatePayoutNumbersWorker } from "./calculate-payout-numbers-worker.ts";
import { calculateSaleNumbersWorker } from "./calculate-sale-numbers-worker.ts";
import { updateTaxRatesJob } from "./update-tax-rates-job.ts";
import { compileGumroadDailyAnalyticsJob } from "./compile-gumroad-daily-analytics-job.ts";
import { cancelSubscriptionsForProductWorker } from "./cancel-subscriptions-for-product-worker.ts";
import {
  contentModerationAdminCommentJob,
  detectLegalEntityCountryDriftJob,
  releaseChargebackRatePayoutPausesJob,
} from "./comment-jobs.ts";
import {
  forceFinishLongRunningCommunityChatRecapRunsJob,
  triggerCommunityChatRecapRunJob,
} from "./community-chat-recap-jobs.ts";
import { customDomainsVerificationWorker } from "./custom-domains-verification-worker.ts";
import { deleteExpiredOauthDeviceAuthorizationsJob } from "./delete-expired-oauth-device-authorizations-job.ts";
import {
  deleteOldPingDeliveriesJob,
  deleteOldProcessedStripeEventsJob,
  deleteOldSentEmailInfoRecordsJob,
} from "./delete-old-records-jobs.ts";
import { deleteOldVersionsRecordsWorker } from "./delete-old-versions-records-worker.ts";
import { deleteProductFilesArchivesWorker } from "./delete-product-files-archives-worker.ts";
import { deleteProductRichContentWorker } from "./delete-product-rich-content-worker.ts";
import { deleteUnusedPublicFilesJob } from "./delete-unused-public-files-job.ts";
import { deleteWishlistProductsJob } from "./delete-wishlist-products-job.ts";
import { dispatchPendingWorkflowInstallmentScheduleIntentsJob } from "./dispatch-workflow-intents-job.ts";
import { detectFailingPaypalRailsJob } from "./detect-failing-paypal-rails-job.ts";
import { disputeEvidenceDueSoonReminderJob } from "./dispute-evidence-due-soon-reminder-job.ts";
import { elasticsearchIndexerWorker } from "./elasticsearch-indexer-worker.ts";
import { enforceRefundPolicyForSellerJob } from "./enforce-refund-policy-for-seller-job.ts";
import { alertOnBlockedEstablishedBuyersJob } from "./alert-on-blocked-established-buyers-job.ts";
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { expireTranscodedVideosJob } from "./expire-transcoded-videos-job.ts";
import { expiringCreditCardMessageWorker } from "./expiring-credit-card-message-worker.ts";
import { flushDeliveredEmailInfosJob } from "./flush-delivered-email-infos-job.ts";
import { generateUsernameJob } from "./generate-username-job.ts";
import { handleGrmcCallbackJob } from "./handle-grmc-callback-job.ts";
import { handleNewUserComplianceInfoWorker } from "./handle-new-user-compliance-info-worker.ts";
import { googleCalendarInviteJob } from "./google-calendar-invite-job.ts";
import { handleResendEventJob } from "./handle-resend-event-job.ts";
import { handleSendgridEventJob } from "./handle-sendgrid-event-job.ts";
import { handleSnsAwsConfigEventWorker } from "./handle-sns-aws-config-event-worker.ts";
import { handleSnsMediaconvertEventWorker } from "./handle-sns-mediaconvert-event-worker.ts";
import { handleStripeAutodebitForNegativeBalance } from "./handle-stripe-autodebit-job.ts";
import { internalNotificationWorker } from "./internal-notification-worker.ts";
import { invalidateProductCacheWorker } from "./invalidate-product-cache-worker.ts";
import { expireStampedPdfsJob, updateLargeSellersSalesCountJob } from "./large-seller-and-stamped-pdf-jobs.ts";
import {
  liftPlatformStripePauseJob,
  liftPlatformStripePauseJobRetriesExhausted,
  liftPlatformStripePauseJobRetryIn,
} from "./lift-platform-stripe-pause-job.ts";
import { logResendEventJob } from "./log-resend-event-job.ts";
import { logSendgridEventWorker } from "./log-sendgrid-event-worker.ts";
import { millionDollarMilestoneCheckWorker } from "./million-dollar-milestone-check-worker.ts";
import { moderateProductsJob } from "./moderate-products-job.ts";
import { orderReviewReminderJob } from "./order-review-reminder-job.ts";
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
import { chargeSuccessfulPreordersWorker } from "./charge-successful-preorders-worker.ts";
import { renameProductFileWorker } from "./rename-product-file-worker.ts";
import { deleteProductFilesWorker } from "./delete-product-files-worker.ts";
import { recoverStrandedBuyersJobWith } from "./recover-stranded-buyers-job.ts";
import { alertOnStalledPostEmailBlastsJobWith } from "./alert-on-stalled-post-email-blasts-job.ts";
import { createLicensesForExistingCustomersWorkerWith } from "./create-licenses-for-existing-customers-worker.ts";
import { alertOnStuckPiracyReportsJobWith } from "./alert-on-stuck-piracy-reports-job.ts";
import {
  refreshAffiliateEarningsJob,
  refreshAffiliateEarningsJobRetriesExhausted,
} from "./refresh-affiliate-earnings-job.ts";
import { cancelPreorderWorker } from "./cancel-preorder-worker.ts";
import { processAssetPreviewRetinaWorker } from "./process-asset-preview-retina-worker.ts";
import { processPaymentWorker } from "./process-payment-worker.ts";
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
import { purgeOldDeletedAssetPreviewsWorker } from "./purge-old-deleted-asset-previews-worker.ts";
import { radarSyncValueListsJob } from "./radar-sync-value-lists-job.ts";
import { radarAddValueListItemJob, radarRemoveValueListItemJob } from "./radar-value-list-jobs.ts";
import { rebuildGmailAbuseFilterJob } from "./rebuild-gmail-abuse-filter-job.ts";
import { recordOrderChargeOutcomeJob } from "./record-order-charge-outcome-job.ts";
import { recordProductFileMissingFromStorageJob } from "./record-product-file-missing-from-storage-job.ts";
import { recordSocialScoreShadowEvaluationsJob } from "./record-social-score-shadow-evaluations-job.ts";
import { recoverAusBacktaxFromStripeAccountJob } from "./recover-aus-backtax-from-stripe-account-job.ts";
import { refreshAudienceMemberJob } from "./refresh-audience-member-job.ts";
import { refreshClosedTierDiscoverPricesJob } from "./refresh-closed-tier-discover-prices-job.ts";
import { refreshCustomDomainRoutabilityWorker } from "./refresh-custom-domain-routability-worker.ts";
import { refreshHighVolumeSellerFeeEligibilityJob } from "./refresh-high-volume-seller-fee-eligibility-job.ts";
import { refreshMerchantAccountPaymentMethodAvailabilityWorker } from "./refresh-merchant-account-payment-method-availability-worker.ts";
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
import { regenerateCreatorAnalyticsCacheWorker } from "./regenerate-creator-analytics-cache-worker.ts";
import { regenerateSalesRelatedProductsInfosJob } from "./regenerate-sales-related-products-infos-job.ts";
import {
  reindexSellerOfferCodesJob,
  reindexSellerOfferCodesJobRetriesExhausted,
  reindexSellerOfferCodesRecoveryJob,
  reindexSellerOfferCodesRecoveryJobRetriesExhausted,
} from "./reindex-seller-offer-codes-job.ts";
import { releaseChargebackRatePayoutPauseForSellerJob } from "./release-chargeback-rate-payout-pause-for-seller-job.ts";
import { reindexUserElasticsearchDataWorker } from "./reindex-user-elasticsearch-data-worker.ts";
import { removeSuspendedAccountFollowsWorker } from "./remove-suspended-account-follows-worker.ts";
import { retryStripeJpAddressResyncForSellerJob } from "./retry-stripe-jp-address-resync-for-seller-job.ts";
import { retryStripeJpAddressResyncsJob } from "./retry-stripe-jp-address-resyncs-job.ts";
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
import { removeDeletedFilesFromS3Job } from "./remove-deleted-files-from-s3-job.ts";
import { sellerUpdateWorker } from "./seller-update-worker.ts";
import { sellerUpdatesWorker } from "./seller-updates-worker.ts";
import { sendCommunityChatRecapNotificationsJob } from "./send-community-chat-recap-notifications-job.ts";
import { sendFeatureAnnouncementCampaignJob } from "./send-feature-announcement-campaign-job.ts";
import {
  refreshSitemapDailyWorker,
  refreshSitemapMonthlyWorker,
  refreshWishlistSitemapDailyWorker,
} from "./sitemap-workers.ts";
import { sendLastPostJob } from "./send-last-post-job.ts";
import { sendMarketingXReconnectEmailJob } from "./send-marketing-x-reconnect-email-job.ts";
import { sendPaymentReminderWorker } from "./send-payment-reminder-worker.ts";
import { sendPreorderSellerSummaryWorker } from "./send-preorder-seller-summary-worker.ts";
import { sendPurchaseReceiptJob } from "./send-purchase-receipt-job.ts";
import { sendWishlistUpdatedEmailsJob } from "./send-wishlist-updated-emails-job.ts";
import { sendWorkflowInstallmentWorker } from "./send-workflow-installment-worker.ts";
import {
  createStripeApplePayDomainWorker,
  createStripeApplePayDomainWorkerRetriesExhausted,
  deleteStripeApplePayDomainWorker,
  syncStripeBusinessProfileUrlJob,
} from "./stripe-jobs.ts";
import { submitToIndexnowJob } from "./submit-to-indexnow-job.ts";
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
import { subtitleFileSizeWorker } from "./subtitle-file-size-worker.ts";
import { suspendAccountsWithPaymentAddressWorker, suspendUsersWorker } from "./suspend-jobs.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import { syncWatchedUsersJob } from "./sync-watched-users-job.ts";
import type { JobHandler } from "./types.ts";
import { updateCachedSalesRelatedProductsInfosJob } from "./update-cached-sales-related-products-infos-job.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import { updatePurchaseEmailToMatchAccountWorker } from "./update-purchase-email-to-match-account-worker.ts";
import { updatePurchasingPowerParityFactorsWorker } from "./update-purchasing-power-parity-factors-worker.ts";
import { updateSalesRelatedProductsInfosJob } from "./update-sales-related-products-infos-job.ts";
import { updateSellerRefundEligibilityJob } from "./update-seller-refund-eligibility-job.ts";
import { updateTaxonomyStatsJob } from "./update-taxonomy-stats-job.ts";
import { stripePayoutsPausedEmailJob } from "./stripe-payouts-paused-email-job.ts";
import { scheduleMembershipPriceUpdatesJob } from "./schedule-membership-price-updates-job.ts";
import { updateBundlePurchasesContentJob } from "./update-bundle-purchases-content-job.ts";
import { staleTransientSuppressionSweepJob } from "./stale-transient-suppression-sweep-job.ts";
import { resendConfirmationEmailJob } from "./resend-confirmation-email-job.ts";
import { pdfUnstampableNotifierJob } from "./pdf-unstampable-notifier-job.ts";
import { generateLargeSellersAnalyticsCacheWorker } from "./generate-large-sellers-analytics-cache-worker.ts";
import { sendSignedPiracyNoticesJob } from "./send-signed-piracy-notices-job.ts";
import { renewCustomDomainSslCertificates } from "./renew-custom-domain-ssl-certificates.ts";
import { sendPaypalTopupNotificationJob } from "./send-paypal-topup-notification-job.ts";
import { updateIntegrationsOnTierChangeWorker } from "./update-integrations-on-tier-change-worker.ts";
import { deactivateIntegrationsWorker } from "./deactivate-integrations-worker.ts";
import { activateIntegrationsWorker } from "./activate-integrations-worker.ts";
import { generateProductFilesArchivesJob } from "./generate-product-files-archives-job.ts";
import { updateUtmLinkStatsJob } from "./update-utm-link-stats-job.ts";
import { utmLinkSaleAttributionJob } from "./utm-link-sale-attribution-job.ts";
import { warmSellerReputationSummaryJob } from "./warm-seller-reputation-summary-job.ts";
import { processEarlyFraudWarningJob } from "./process-early-fraud-warning-job.ts";
import { createStripeMerchantAccountWorker } from "./create-stripe-merchant-account-worker.ts";
import { analyzeFileWorker } from "./analyze-file-worker.ts";
import { transferDropboxFileToS3Worker } from "./transfer-dropbox-file-to-s3-worker.ts";
import { generateVideoPosterWorker } from "./generate-video-poster-worker.ts";
import { resizeOversizedAssetPreviewWorker } from "./resize-oversized-asset-preview-worker.ts";
import { massRefundForFraudJob } from "./mass-refund-for-fraud-job.ts";
import { chargePreorderWorker } from "./charge-preorder-worker.ts";
import { pushNotificationWorker } from "./push-notification-worker.ts";
import { finalizeBuyerPresentmentPurchaseJob } from "./finalize-buyer-presentment-purchase-job.ts";
import { attachPastPurchasesToUserWorker } from "./attach-past-purchases-to-user-worker.ts";
import { stripeRestraintNoticeEmailJob } from "./stripe-restraint-notice-email-job.ts";
import {
  emailOutstandingBalancesCsvWorker,
  emailOutstandingBalancesCsvWorkerRetriesExhausted,
  sendDailyFinanceLedgerReportJob,
  sendDailyFinanceLedgerReportJobRetriesExhausted,
  sendDeferredRefundsReportWorker,
  sendDeferredRefundsReportWorkerRetriesExhausted,
  sendFinancesReportWorker,
  sendFinancesReportWorkerRetriesExhausted,
  sendStripeBalanceSummariesReportJob,
  sendStripeBalanceSummariesReportJobRetriesExhausted,
  sendStripeCurrencyBalancesReportJob,
  sendStripeCurrencyBalancesReportJobRetriesExhausted,
} from "./finance-report-jobs.ts";
import { recalculateRecentWishlistFollowerCountJob } from "./wishlist-jobs.ts";
import {
  flushInstallmentDeliveredDeltasJob,
  scheduleAffiliateWorkflowJobsJob,
  scheduleWorkflowEmailsWorker,
  sendWorkflowInstallmentRescheduleJob,
  updateInstallmentEventsCountCacheWorker,
} from "./workflow-jobs.ts";

export const JOB_HANDLERS: Record<string, JobHandler> = {
  UpdateTaxRatesJob: updateTaxRatesJob,
  CompileGumroadDailyAnalyticsJob: compileGumroadDailyAnalyticsJob,
  CancelSubscriptionsForProductWorker: cancelSubscriptionsForProductWorker,
  CancelPreorderWorker: cancelPreorderWorker,
  DeleteProductFilesWorker: deleteProductFilesWorker,
  RefreshAffiliateEarningsJob: refreshAffiliateEarningsJob,
  AlertOnStuckPiracyReportsJob: alertOnStuckPiracyReportsJobWith(),
  AlertOnStalledPostEmailBlastsJob: alertOnStalledPostEmailBlastsJobWith(),
  CreateLicensesForExistingCustomersWorker: createLicensesForExistingCustomersWorkerWith(),
  RecoverStrandedBuyersJob: recoverStrandedBuyersJobWith(),
  RenameProductFileWorker: renameProductFileWorker,
  ChargeSuccessfulPreordersWorker: chargeSuccessfulPreordersWorker,
  ProcessAssetPreviewRetinaWorker: processAssetPreviewRetinaWorker,
  RefreshMerchantAccountPaymentMethodAvailabilityWorker: refreshMerchantAccountPaymentMethodAvailabilityWorker,
  HandleGrmcCallbackJob: handleGrmcCallbackJob,
  HandleSnsMediaconvertEventWorker: handleSnsMediaconvertEventWorker,
  HandleNewUserComplianceInfoWorker: handleNewUserComplianceInfoWorker,
  RegenerateCreatorAnalyticsCacheWorker: regenerateCreatorAnalyticsCacheWorker,
  ReindexUserElasticsearchDataWorker: reindexUserElasticsearchDataWorker,
  ModerateProductsJob: moderateProductsJob,
  RecordSocialScoreShadowEvaluationsJob: recordSocialScoreShadowEvaluationsJob,
  MillionDollarMilestoneCheckWorker: millionDollarMilestoneCheckWorker,
  RefreshCustomDomainRoutabilityWorker: refreshCustomDomainRoutabilityWorker,
  ProcessPaymentWorker: processPaymentWorker,
  RetryStripeJpAddressResyncsJob: retryStripeJpAddressResyncsJob,
  SyncWatchedUsersJob: syncWatchedUsersJob,
  RecordOrderChargeOutcomeJob: recordOrderChargeOutcomeJob,
  OrderReviewReminderJob: orderReviewReminderJob,
  AlertOnRetiredManagedAccountActivityJob: alertOnRetiredManagedAccountActivityJob,
  AlertOnZeroBuyerCurrencyWalletPurchasesJob: alertOnZeroBuyerCurrencyWalletPurchasesJob,
  "Radar::SyncValueListsJob": radarSyncValueListsJob,
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
  ExpireTranscodedVideosJob: expireTranscodedVideosJob,
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
  UpdateCachedSalesRelatedProductsInfosJob: updateCachedSalesRelatedProductsInfosJob,
  UpdatePurchasingPowerParityFactorsWorker: updatePurchasingPowerParityFactorsWorker,
  UpdateSellerRefundEligibilityJob: updateSellerRefundEligibilityJob,
  UpdateUtmLinkStatsJob: updateUtmLinkStatsJob,
  UtmLinkSaleAttributionJob: utmLinkSaleAttributionJob,
  StripePayoutsPausedEmailJob: stripePayoutsPausedEmailJob,
  ScheduleMembershipPriceUpdatesJob: scheduleMembershipPriceUpdatesJob,
  UpdateBundlePurchasesContentJob: updateBundlePurchasesContentJob,
  StaleTransientSuppressionSweepJob: staleTransientSuppressionSweepJob,
  ResendConfirmationEmailJob: resendConfirmationEmailJob,
  PdfUnstampableNotifierJob: pdfUnstampableNotifierJob,
  GenerateLargeSellersAnalyticsCacheWorker: generateLargeSellersAnalyticsCacheWorker,
  SendSignedPiracyNoticesJob: sendSignedPiracyNoticesJob,
  RenewCustomDomainSslCertificates: renewCustomDomainSslCertificates,
  SendPaypalTopupNotificationJob: sendPaypalTopupNotificationJob,
  UpdateIntegrationsOnTierChangeWorker: updateIntegrationsOnTierChangeWorker,
  DeactivateIntegrationsWorker: deactivateIntegrationsWorker,
  ActivateIntegrationsWorker: activateIntegrationsWorker,
  GenerateProductFilesArchivesJob: generateProductFilesArchivesJob,
  AlertOnBlockedEstablishedBuyersJob: alertOnBlockedEstablishedBuyersJob,
  WarmSellerReputationSummaryJob: warmSellerReputationSummaryJob,
  FightDisputeJob: fightDisputeJob,
  PayoutUsersWorker: payoutUsersWorker,
  DeleteWishlistProductsJob: deleteWishlistProductsJob,
  DeleteExpiredOauthDeviceAuthorizationsJob: deleteExpiredOauthDeviceAuthorizationsJob,
  FlushDeliveredEmailInfosJob: flushDeliveredEmailInfosJob,
  DeleteProductFilesArchivesWorker: deleteProductFilesArchivesWorker,
  PurgeOldDeletedAssetPreviewsWorker: purgeOldDeletedAssetPreviewsWorker,
  DetectFailingPaypalRailsJob: detectFailingPaypalRailsJob,
  EnforceRefundPolicyForSellerJob: enforceRefundPolicyForSellerJob,
  GoogleCalendarInviteJob: googleCalendarInviteJob,
  HandleResendEventJob: handleResendEventJob,
  HandleSendgridEventJob: handleSendgridEventJob,
  RefreshAudienceMemberJob: refreshAudienceMemberJob,
  RefreshSitemapDailyWorker: refreshSitemapDailyWorker,
  RefreshSitemapMonthlyWorker: refreshSitemapMonthlyWorker,
  RemoveDeletedFilesFromS3Job: removeDeletedFilesFromS3Job,
  RefreshWishlistSitemapDailyWorker: refreshWishlistSitemapDailyWorker,
  RefreshClosedTierDiscoverPricesJob: refreshClosedTierDiscoverPricesJob,
  BackfillPriceCheckerIndexFieldsJob: backfillPriceCheckerIndexFieldsJob,
  DeleteUnusedPublicFilesJob: deleteUnusedPublicFilesJob,
  RegenerateSalesRelatedProductsInfosJob: regenerateSalesRelatedProductsInfosJob,
  UpdateSalesRelatedProductsInfosJob: updateSalesRelatedProductsInfosJob,
  UpdateTaxonomyStatsJob: updateTaxonomyStatsJob,
  CalculateSaleNumbersWorker: calculateSaleNumbersWorker,
  SellerUpdateWorker: sellerUpdateWorker,
  SubtitleFileSizeWorker: subtitleFileSizeWorker,
  CalculatePayoutNumbersWorker: calculatePayoutNumbersWorker,
  "Radar::AddValueListItemJob": radarAddValueListItemJob,
  "Radar::RemoveValueListItemJob": radarRemoveValueListItemJob,
  ExpiringCreditCardMessageWorker: expiringCreditCardMessageWorker,
  SendWishlistUpdatedEmailsJob: sendWishlistUpdatedEmailsJob,
  SendPaymentReminderWorker: sendPaymentReminderWorker,
  SendFeatureAnnouncementCampaignJob: sendFeatureAnnouncementCampaignJob,
  SendPreorderSellerSummaryWorker: sendPreorderSellerSummaryWorker,
  SubmitToIndexnowJob: submitToIndexnowJob,
  DeleteProductRichContentWorker: deleteProductRichContentWorker,
  RemoveSuspendedAccountFollowsWorker: removeSuspendedAccountFollowsWorker,
  RefundPurchaseWorker: refundPurchaseWorker,
  UpdateUserBalanceStatsCacheWorker: updateUserBalanceStatsCacheWorker,
  BackfillTaggingsCountOnTagsJob: backfillTaggingsCountOnTagsJob,
  RebuildGmailAbuseFilterJob: rebuildGmailAbuseFilterJob,
  InvalidateProductCacheWorker: invalidateProductCacheWorker,
  CacheProductDataWorker: cacheProductDataWorker,
  BackfillOrphanedShownProductsInProfileSectionsJob: backfillOrphanedShownProductsInProfileSectionsJob,
  RefreshHighVolumeSellerFeeEligibilityJob: refreshHighVolumeSellerFeeEligibilityJob,
  ReindexSellerOfferCodesJob: reindexSellerOfferCodesJob,
  ReindexSellerOfferCodesRecoveryJob: reindexSellerOfferCodesRecoveryJob,
  CustomDomainsVerificationWorker: customDomainsVerificationWorker,
  RecordProductFileMissingFromStorageJob: recordProductFileMissingFromStorageJob,
  UpdatePurchaseEmailToMatchAccountWorker: updatePurchaseEmailToMatchAccountWorker,
  ReleaseChargebackRatePayoutPauseForSellerJob: releaseChargebackRatePayoutPauseForSellerJob,
  RetryStripeJpAddressResyncForSellerJob: retryStripeJpAddressResyncForSellerJob,
  GenerateUsernameJob: generateUsernameJob,
  ProcessEarlyFraudWarningJob: processEarlyFraudWarningJob,
  CreateStripeMerchantAccountWorker: createStripeMerchantAccountWorker,
  AnalyzeFileWorker: analyzeFileWorker,
  TransferDropboxFileToS3Worker: transferDropboxFileToS3Worker,
  GenerateVideoPosterWorker: generateVideoPosterWorker,
  ResizeOversizedAssetPreviewWorker: resizeOversizedAssetPreviewWorker,
  MassRefundForFraudJob: massRefundForFraudJob,
  ChargePreorderWorker: chargePreorderWorker,
  PushNotificationWorker: pushNotificationWorker,
  FinalizeBuyerPresentmentPurchaseJob: finalizeBuyerPresentmentPurchaseJob,
  AttachPastPurchasesToUserWorker: attachPastPurchasesToUserWorker,
  StripeRestraintNoticeEmailJob: stripeRestraintNoticeEmailJob,
  EmailOutstandingBalancesCsvWorker: emailOutstandingBalancesCsvWorker,
  SendStripeCurrencyBalancesReportJob: sendStripeCurrencyBalancesReportJob,
  SendDeferredRefundsReportWorker: sendDeferredRefundsReportWorker,
  SendFinancesReportWorker: sendFinancesReportWorker,
  SendStripeBalanceSummariesReportJob: sendStripeBalanceSummariesReportJob,
  SendDailyFinanceLedgerReportJob: sendDailyFinanceLedgerReportJob,
};

// `sidekiq_retry_in` and `sidekiq_retries_exhausted` blocks of ported jobs, keyed by Ruby class name.
// The worker refuses to start when a ported job defines one in Ruby and has none here.
export const JOB_RETRY_IN: Record<string, RetryIn> = {
  LiftPlatformStripePauseJob: liftPlatformStripePauseJobRetryIn,
};

export const JOB_RETRIES_EXHAUSTED: Record<string, RetriesExhausted> = {
  CreateStripeApplePayDomainWorker: createStripeApplePayDomainWorkerRetriesExhausted,
  LiftPlatformStripePauseJob: liftPlatformStripePauseJobRetriesExhausted,
  ReindexSellerOfferCodesJob: reindexSellerOfferCodesJobRetriesExhausted,
  ReindexSellerOfferCodesRecoveryJob: reindexSellerOfferCodesRecoveryJobRetriesExhausted,
  RefreshAffiliateEarningsJob: refreshAffiliateEarningsJobRetriesExhausted,
  EmailOutstandingBalancesCsvWorker: emailOutstandingBalancesCsvWorkerRetriesExhausted,
  SendStripeCurrencyBalancesReportJob: sendStripeCurrencyBalancesReportJobRetriesExhausted,
  SendDeferredRefundsReportWorker: sendDeferredRefundsReportWorkerRetriesExhausted,
  SendFinancesReportWorker: sendFinancesReportWorkerRetriesExhausted,
  SendStripeBalanceSummariesReportJob: sendStripeBalanceSummariesReportJobRetriesExhausted,
  SendDailyFinanceLedgerReportJob: sendDailyFinanceLedgerReportJobRetriesExhausted,
};
