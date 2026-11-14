// Handlers for every class in src/server/jobs/ported-jobs.ts, keyed by Ruby class name.
import type { RetriesExhausted, RetryIn } from "../retry.ts";

import { activateIntegrationsWorker } from "./activate-integrations-worker.ts";
import { alertOnBlockedEstablishedBuyersJob } from "./alert-on-blocked-established-buyers-job.ts";
import { alertOnBlockedEstablishedSubscribersJob } from "./alert-on-blocked-established-subscribers-job.ts";
import { alertOnRetiredManagedAccountActivityJob } from "./alert-on-retired-managed-account-activity-job.ts";
import { alertOnStaleBlocksHoldingEstablishedBuyersJob } from "./alert-on-stale-blocks-holding-established-buyers-job.ts";
import { alertOnStalledPostEmailBlastsJobWith } from "./alert-on-stalled-post-email-blasts-job.ts";
import { alertOnStuckPiracyReportsJobWith } from "./alert-on-stuck-piracy-reports-job.ts";
import { alertOnZeroBuyerCurrencyWalletPurchasesJob } from "./alert-on-zero-buyer-currency-wallet-purchases-job.ts";
import { alertSellersOfUndeliveredReceiptsJob } from "./alert-sellers-of-undelivered-receipts-job.ts";
import { analyzeFileWorker } from "./analyze-file-worker.ts";
import { annualPayoutExportWorker } from "./annual-payout-export-worker.ts";
import { attachPastPurchasesToUserWorker } from "./attach-past-purchases-to-user-worker.ts";
import { backfillMembershipRenewalRemindersJob } from "./backfill-membership-renewal-reminders-job.ts";
import { backfillOrphanedShownProductsInProfileSectionsJob } from "./backfill-orphaned-shown-products-in-profile-sections-job.ts";
import { backfillPdfStampsJob } from "./backfill-pdf-stamps-job.ts";
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
import { cancelPreorderWorker } from "./cancel-preorder-worker.ts";
import { cancelSubscriptionsForProductWorker } from "./cancel-subscriptions-for-product-worker.ts";
import { chargePreorderWorker } from "./charge-preorder-worker.ts";
import { chargeSuccessfulPreordersWorker } from "./charge-successful-preorders-worker.ts";
import { collectUnclaimedBalancesOfInactiveStripeAccountsJob } from "./collect-unclaimed-balances-of-inactive-stripe-accounts-job.ts";
import {
  contentModerationAdminCommentJob,
  detectLegalEntityCountryDriftJob,
  releaseChargebackRatePayoutPausesJob,
} from "./comment-jobs.ts";
import {
  forceFinishLongRunningCommunityChatRecapRunsJob,
  triggerCommunityChatRecapRunJob,
} from "./community-chat-recap-jobs.ts";
import { compileGumroadDailyAnalyticsJob } from "./compile-gumroad-daily-analytics-job.ts";
import { createLicensesForExistingCustomersWorkerWith } from "./create-licenses-for-existing-customers-worker.ts";
import { createStripeMerchantAccountWorker } from "./create-stripe-merchant-account-worker.ts";
import { customDomainVerificationWorker } from "./custom-domain-verification-worker.ts";
import { customDomainsVerificationWorker } from "./custom-domains-verification-worker.ts";
import { deactivateIntegrationsWorker } from "./deactivate-integrations-worker.ts";
import { deleteExpiredOauthDeviceAuthorizationsJob } from "./delete-expired-oauth-device-authorizations-job.ts";
import {
  deleteOldPingDeliveriesJob,
  deleteOldProcessedStripeEventsJob,
  deleteOldSentEmailInfoRecordsJob,
} from "./delete-old-records-jobs.ts";
import { deleteOldVersionsRecordsWorker } from "./delete-old-versions-records-worker.ts";
import { deleteProductFilesArchivesWorker } from "./delete-product-files-archives-worker.ts";
import { deleteProductFilesWorker } from "./delete-product-files-worker.ts";
import { deleteProductRichContentWorker } from "./delete-product-rich-content-worker.ts";
import { deleteUnusedPublicFilesJob } from "./delete-unused-public-files-job.ts";
import { deleteWishlistProductsJob } from "./delete-wishlist-products-job.ts";
import { deliverFilesReadyNotificationJob } from "./deliver-files-ready-notification-job.ts";
import { detectFailingPaypalRailsJob } from "./detect-failing-paypal-rails-job.ts";
import { dispatchPendingPartnerMigrationNotificationsJob } from "./dispatch-pending-partner-migration-notifications-job.ts";
import { dispatchProductPublishSchedulesJob } from "./dispatch-product-publish-schedules-job.ts";
import { dispatchPendingWorkflowInstallmentScheduleIntentsJob } from "./dispatch-workflow-intents-job.ts";
import { disputeEvidenceDueSoonReminderJob } from "./dispute-evidence-due-soon-reminder-job.ts";
import { duplicateProductWorker } from "./duplicate-product-worker.ts";
import { elasticsearchIndexerWorker } from "./elasticsearch-indexer-worker.ts";
import { enforceRefundPolicyForSellerJob } from "./enforce-refund-policy-for-seller-job.ts";
import { enqueueMarketingXReconnectEmailJob } from "./enqueue-marketing-x-reconnect-email-job.ts";
import { expireTranscodedVideosJob } from "./expire-transcoded-videos-job.ts";
import { expiringCreditCardMessageWorker } from "./expiring-credit-card-message-worker.ts";
import { exportPayoutData } from "./export-payout-data.ts";
import { compileChunksWorker, processChunkWorker } from "./exports-sales-chunk-workers.ts";
import { createAndEnqueueChunksWorker } from "./exports-sales-create-and-enqueue-chunks-worker.ts";
import { finalizeBuyerPresentmentChargeJob } from "./finalize-buyer-presentment-charge-job.ts";
import { finalizeBuyerPresentmentPurchaseJob } from "./finalize-buyer-presentment-purchase-job.ts";
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
import { flushDeliveredEmailInfosJob } from "./flush-delivered-email-infos-job.ts";
import { generateAvatarVariantJob } from "./generate-avatar-variant-job.ts";
import {
  generateCommunityChatRecapJob,
  generateCommunityChatRecapJobRetriesExhausted,
} from "./generate-community-chat-recap-job.ts";
import {
  generateFinancialReportsForPreviousMonthJob,
  generateFinancialReportsForPreviousMonthJobRetriesExhausted,
  generateFinancialReportsForPreviousQuarterJob,
  generateFinancialReportsForPreviousQuarterJobRetriesExhausted,
} from "./generate-financial-reports-jobs.ts";
import { generateLargeSellersAnalyticsCacheWorker } from "./generate-large-sellers-analytics-cache-worker.ts";
import { generateMerchantCenterFeedWorker } from "./generate-merchant-center-feed-worker.ts";
import { generateProductFilesArchivesJob } from "./generate-product-files-archives-job.ts";
import { generateSslCertificate, generateSslCertificateRetriesExhausted } from "./generate-ssl-certificate.ts";
import {
  generateSubscribePreviewJob,
  generateSubscribePreviewJobRetriesExhausted,
} from "./generate-subscribe-preview-job.ts";
import { generateUsernameJob } from "./generate-username-job.ts";
import { generateVideoPosterWorker } from "./generate-video-poster-worker.ts";
import { googleCalendarInviteJob } from "./google-calendar-invite-job.ts";
import { handleGrmcCallbackJob } from "./handle-grmc-callback-job.ts";
import { handleNewUserComplianceInfoWorker } from "./handle-new-user-compliance-info-worker.ts";
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
import { massRefundForFraudJob } from "./mass-refund-for-fraud-job.ts";
import { mcpDeleteExpiredEventSubscriptionsJob } from "./mcp-delete-expired-event-subscriptions-job.ts";
import { mcpDeliverEventJob } from "./mcp-deliver-event-job.ts";
import { alertOnStripeDobDriftJob, sweepClosedSellerConnectAccountsJob } from "./merchant-account-cursor-sweep-jobs.ts";
import { millionDollarMilestoneCheckWorker } from "./million-dollar-milestone-check-worker.ts";
import { moderateProductsJob } from "./moderate-products-job.ts";
import { orderReviewReminderJob } from "./order-review-reminder-job.ts";
import {
  partnerMigrationImportJob,
  partnerMigrationImportJobRetriesExhausted,
} from "./partner-migration-import-job.ts";
import { partnerMigrationNotificationJob } from "./partner-migration-notification-job.ts";
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
import {
  performPayoutsForUserSliceWorker,
  performPayoutsForUserSliceWorkerRetriesExhausted,
  performPayoutsUpToDelayDaysAgoWorker,
  performPayoutsUpToDelayDaysAgoWorkerRetriesExhausted,
} from "./payout-batch-jobs.ts";
import {
  deleteGuardianStripePersonJob,
  deleteGuardianStripePersonJobRetriesExhausted,
  handleNewBankAccountWorker,
  handleNewBankAccountWorkerRetriesExhausted,
} from "./payout-note-retries-exhausted-jobs.ts";
import { pdfUnstampableNotifierJob } from "./pdf-unstampable-notifier-job.ts";
import { blockEmailDomainsWorker, blockObjectWorker, unblockObjectWorker } from "./platform-block-jobs.ts";
import { postToPingEndpointsWorker } from "./post-to-ping-endpoints-worker.ts";
import { processAssetPreviewRetinaWorker } from "./process-asset-preview-retina-worker.ts";
import { processEarlyFraudWarningJob } from "./process-early-fraud-warning-job.ts";
import { processPaymentWorker } from "./process-payment-worker.ts";
import { productBuildUnpackJob } from "./product-build-unpack-job.ts";
import {
  refreshMerchantAccountProductsRecommendationEligibilityJob,
  refreshUserProductsRecommendationEligibilityJob,
  reindexRecommendableProductsWorker,
  sendToElasticsearchWorker,
} from "./product-search-jobs.ts";
import { sendStripeBalanceCheckNotificationJob, verifyFinanceReportsDeliveryJob } from "./production-only-jobs.ts";
import { publishScheduledPostJob } from "./publish-scheduled-post-job.ts";
import { publishScheduledProductJob } from "./publish-scheduled-product-job.ts";
import {
  createMissingPurchaseEventsWorker,
  expireRentalPurchasesWorker,
  findExpiredSubscriptionsToSetAsDeactivatedWorker,
  sendRentalExpiresSoonEmailWorker,
  syncStuckPurchasesJob,
  updatePurchaseHealthcheckThresholdJob,
} from "./purchase-reads-jobs.ts";
import { purchaseRefundRequestsEscalateOverdueJob } from "./purchase-refund-requests-escalate-overdue-job.ts";
import { purgeOldDeletedAssetPreviewsWorker } from "./purge-old-deleted-asset-previews-worker.ts";
import { pushNotificationWorker } from "./push-notification-worker.ts";
import { radarSyncValueListsJob } from "./radar-sync-value-lists-job.ts";
import { radarAddValueListItemJob, radarRemoveValueListItemJob } from "./radar-value-list-jobs.ts";
import { rebuildGmailAbuseFilterJob } from "./rebuild-gmail-abuse-filter-job.ts";
import { reconcileClientConfirmedChargeJob } from "./reconcile-client-confirmed-charge-job.ts";
import { reconcilePendingPaypalRefundsJob } from "./reconcile-pending-paypal-refunds-job.ts";
import { reconcileStripePayoutsPauseForSellerJob } from "./reconcile-stripe-payouts-pause-for-seller-job.ts";
import { reconcileStripePayoutsPausesJob } from "./reconcile-stripe-payouts-pauses-job.ts";
import { recordOrderChargeOutcomeJob } from "./record-order-charge-outcome-job.ts";
import { recordProductFileMissingFromStorageJob } from "./record-product-file-missing-from-storage-job.ts";
import { recordSocialScoreShadowEvaluationsJob } from "./record-social-score-shadow-evaluations-job.ts";
import { recordUtmLinkVisitJob } from "./record-utm-link-visit-job.ts";
import { recoverAusBacktaxFromStripeAccountJob } from "./recover-aus-backtax-from-stripe-account-job.ts";
import { recoverStrandedBuyersJobWith } from "./recover-stranded-buyers-job.ts";
import {
  refreshAffiliateEarningsJob,
  refreshAffiliateEarningsJobRetriesExhausted,
} from "./refresh-affiliate-earnings-job.ts";
import { refreshAudienceMemberJob } from "./refresh-audience-member-job.ts";
import { refreshClosedTierDiscoverPricesJob } from "./refresh-closed-tier-discover-prices-job.ts";
import { refreshCustomDomainRoutabilityWorker } from "./refresh-custom-domain-routability-worker.ts";
import { refreshHighVolumeSellerFeeEligibilityJob } from "./refresh-high-volume-seller-fee-eligibility-job.ts";
import { refreshMerchantAccountPaymentMethodAvailabilityWorker } from "./refresh-merchant-account-payment-method-availability-worker.ts";
import { refundAllForFraudWorker } from "./refund-all-for-fraud-worker.ts";
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
import { refundPurchaseForFraudWorker } from "./refund-purchase-for-fraud-worker.ts";
import { regenerateCreatorAnalyticsCacheWorker } from "./regenerate-creator-analytics-cache-worker.ts";
import { regenerateSalesRelatedProductsInfosJob } from "./regenerate-sales-related-products-infos-job.ts";
import {
  reindexSellerOfferCodesJob,
  reindexSellerOfferCodesJobRetriesExhausted,
  reindexSellerOfferCodesRecoveryJob,
  reindexSellerOfferCodesRecoveryJobRetriesExhausted,
} from "./reindex-seller-offer-codes-job.ts";
import { reindexUserElasticsearchDataWorker } from "./reindex-user-elasticsearch-data-worker.ts";
import { reissueSslCertificateForUpdatedCustomDomains } from "./reissue-ssl-certificate-for-updated-custom-domains.ts";
import { releaseChargebackRatePayoutPauseForSellerJob } from "./release-chargeback-rate-payout-pause-for-seller-job.ts";
import { removeDeletedFilesFromS3Job } from "./remove-deleted-files-from-s3-job.ts";
import { removeSuspendedAccountFollowsWorker } from "./remove-suspended-account-follows-worker.ts";
import { renameProductFileWorker } from "./rename-product-file-worker.ts";
import { renewCustomDomainSslCertificates } from "./renew-custom-domain-ssl-certificates.ts";
import { requeueTransientlyFailedPayoutsJob } from "./requeue-transiently-failed-payouts-job.ts";
import { resendConfirmationEmailJob } from "./resend-confirmation-email-job.ts";
import { resizeOversizedAssetPreviewWorker } from "./resize-oversized-asset-preview-worker.ts";
import { resumeStalledPartnerMigrationsJob } from "./resume-stalled-partner-migrations-job.ts";
import { retryFailedPaypalPayoutsWorker } from "./retry-failed-paypal-payouts-worker.ts";
import { retryPendingMandateChargeJob } from "./retry-pending-mandate-charge-job.ts";
import { retryStripeJpAddressResyncForSellerJob } from "./retry-stripe-jp-address-resync-for-seller-job.ts";
import { retryStripeJpAddressResyncsJob } from "./retry-stripe-jp-address-resyncs-job.ts";
import { retryStripeRejectedPayoutSetupForSellerJob } from "./retry-stripe-rejected-payout-setup-for-seller-job.ts";
import { retryStripeRejectedPayoutSetupsJob } from "./retry-stripe-rejected-payout-setups-job.ts";
import {
  reverseDeferredInternalTransferJob,
  reverseDeferredInternalTransferJobRetriesExhausted,
} from "./reverse-deferred-internal-transfer-job.ts";
import { blockSuspendedAccountIpWorker, checkPaymentAddressWorker } from "./risk-jobs.ts";
import { scheduleMembershipPriceUpdatesJob } from "./schedule-membership-price-updates-job.ts";
import { scheduleOpenedNoClickWorkflowEmailsJob } from "./schedule-opened-no-click-workflow-emails-job.ts";
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
import { sellerUpdateWorker } from "./seller-update-worker.ts";
import { sellerUpdatesWorker } from "./seller-updates-worker.ts";
import { sendBundlesMarketingEmailJob } from "./send-bundles-marketing-email-job.ts";
import { sendChargeReceiptJob } from "./send-charge-receipt-job.ts";
import { sendCommunityChatRecapNotificationsJob } from "./send-community-chat-recap-notifications-job.ts";
import { sendFeatureAnnouncementCampaignJob } from "./send-feature-announcement-campaign-job.ts";
import { sendLastPostJob } from "./send-last-post-job.ts";
import { sendMarketingXReconnectEmailJob } from "./send-marketing-x-reconnect-email-job.ts";
import { sendMembershipsPriceUpdateEmailsJob } from "./send-memberships-price-update-emails-job.ts";
import { sendPaymentReminderWorker } from "./send-payment-reminder-worker.ts";
import { sendPaypalTopupNotificationJob } from "./send-paypal-topup-notification-job.ts";
import { sendPostBlastEmailsJob } from "./send-post-blast-emails-job.ts";
import { sendPostBlastEmailsSliceJob } from "./send-post-blast-emails-slice-job.ts";
import { sendPreorderSellerSummaryWorker } from "./send-preorder-seller-summary-worker.ts";
import { sendProductPublishScheduleNoticeJob } from "./send-product-publish-schedule-notice-job.ts";
import { sendPurchaseReceiptJob } from "./send-purchase-receipt-job.ts";
import { sendRemindersForOutstandingUserComplianceInfoRequestsWorker } from "./send-reminders-for-outstanding-user-compliance-info-requests-worker.ts";
import { sendSignedPiracyNoticesJob } from "./send-signed-piracy-notices-job.ts";
import { sendWishlistUpdatedEmailsJob } from "./send-wishlist-updated-emails-job.ts";
import { sendWorkflowEmailToOpenedNonClickerJob } from "./send-workflow-email-to-opened-non-clicker-job.ts";
import { sendWorkflowEmailsToPastCanceledMembersJob } from "./send-workflow-emails-to-past-canceled-members-job.ts";
import { sendWorkflowInstallmentWorker } from "./send-workflow-installment-worker.ts";
import {
  refreshSitemapDailyWorker,
  refreshSitemapMonthlyWorker,
  refreshWishlistSitemapDailyWorker,
} from "./sitemap-workers.ts";
import { staleTransientSuppressionSweepJob } from "./stale-transient-suppression-sweep-job.ts";
import { stampPdfForPurchaseJob } from "./stamp-pdf-for-purchase-job.ts";
import { stripeCreateMerchantAccountsWorker } from "./stripe-create-merchant-accounts-worker.ts";
import {
  createStripeApplePayDomainWorker,
  createStripeApplePayDomainWorkerRetriesExhausted,
  deleteStripeApplePayDomainWorker,
  syncStripeBusinessProfileUrlJob,
} from "./stripe-jobs.ts";
import { stripePayoutsPausedEmailJob } from "./stripe-payouts-paused-email-job.ts";
import { stripeRestraintNoticeEmailJob } from "./stripe-restraint-notice-email-job.ts";
import {
  submitPaypalDisputeEvidenceJob,
  submitPaypalDisputeEvidenceJobRetryIn,
} from "./submit-paypal-dispute-evidence-job.ts";
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
import { syncGuardianToStripeJob } from "./sync-guardian-to-stripe-job.ts";
import { syncStripeBusinessProfileUrlWorker } from "./sync-stripe-business-profile-url-worker.ts";
import { syncWatchedUsersJob } from "./sync-watched-users-job.ts";
import {
  taxFormTransactionReportJob,
  taxFormTransactionReportJobRetriesExhausted,
} from "./tax-form-transaction-report-job.ts";
import { transcodeVideoForStreamingWorker } from "./transcode-video-for-streaming-worker.ts";
import { transferDropboxFileToS3Worker } from "./transfer-dropbox-file-to-s3-worker.ts";
import type { JobHandler } from "./types.ts";
import { unstickStuckInProgressPurchasesJob } from "./unstick-stuck-in-progress-purchases-job.ts";
import { updateBundlePurchasesContentJob } from "./update-bundle-purchases-content-job.ts";
import { updateCachedSalesRelatedProductsInfosJob } from "./update-cached-sales-related-products-infos-job.ts";
import { updateCurrenciesWorker } from "./update-currencies-worker.ts";
import { updateIntegrationsOnTierChangeWorker } from "./update-integrations-on-tier-change-worker.ts";
import { updatePurchaseEmailToMatchAccountWorker } from "./update-purchase-email-to-match-account-worker.ts";
import { updatePurchasingPowerParityFactorsWorker } from "./update-purchasing-power-parity-factors-worker.ts";
import { updateSalesRelatedProductsInfosJob } from "./update-sales-related-products-infos-job.ts";
import { updateSellerRefundEligibilityJob } from "./update-seller-refund-eligibility-job.ts";
import { updateTaxRatesJob } from "./update-tax-rates-job.ts";
import { updateTaxonomyStatsJob } from "./update-taxonomy-stats-job.ts";
import { updateUtmLinkStatsJob } from "./update-utm-link-stats-job.ts";
import { affiliateExportWorker, audienceExportWorker } from "./user-export-workers.ts";
import { utmLinkSaleAttributionJob } from "./utm-link-sale-attribution-job.ts";
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
  PerformPayoutsForUserSliceWorker: performPayoutsForUserSliceWorker,
  PerformPayoutsUpToDelayDaysAgoWorker: performPayoutsUpToDelayDaysAgoWorker,
  RetryStripeJpAddressResyncsJob: retryStripeJpAddressResyncsJob,
  RetryStripeRejectedPayoutSetupsJob: retryStripeRejectedPayoutSetupsJob,
  StripeCreateMerchantAccountsWorker: stripeCreateMerchantAccountsWorker,
  RefundAllForFraudWorker: refundAllForFraudWorker,
  BackfillPdfStampsJob: backfillPdfStampsJob,
  RetryFailedPaypalPayoutsWorker: retryFailedPaypalPayoutsWorker,
  SendMembershipsPriceUpdateEmailsJob: sendMembershipsPriceUpdateEmailsJob,
  SendRemindersForOutstandingUserComplianceInfoRequestsWorker:
    sendRemindersForOutstandingUserComplianceInfoRequestsWorker,
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
  RetryPendingMandateChargeJob: retryPendingMandateChargeJob,
  FinalizeBuyerPresentmentChargeJob: finalizeBuyerPresentmentChargeJob,
  SendChargeReceiptJob: sendChargeReceiptJob,
  GenerateLargeSellersAnalyticsCacheWorker: generateLargeSellersAnalyticsCacheWorker,
  SendSignedPiracyNoticesJob: sendSignedPiracyNoticesJob,
  RenewCustomDomainSslCertificates: renewCustomDomainSslCertificates,
  SendPaypalTopupNotificationJob: sendPaypalTopupNotificationJob,
  UpdateIntegrationsOnTierChangeWorker: updateIntegrationsOnTierChangeWorker,
  DeactivateIntegrationsWorker: deactivateIntegrationsWorker,
  ActivateIntegrationsWorker: activateIntegrationsWorker,
  GenerateProductFilesArchivesJob: generateProductFilesArchivesJob,
  AlertOnBlockedEstablishedBuyersJob: alertOnBlockedEstablishedBuyersJob,
  AlertOnBlockedEstablishedSubscribersJob: alertOnBlockedEstablishedSubscribersJob,
  RequeueTransientlyFailedPayoutsJob: requeueTransientlyFailedPayoutsJob,
  WarmSellerReputationSummaryJob: warmSellerReputationSummaryJob,
  FightDisputeJob: fightDisputeJob,
  PayoutUsersWorker: payoutUsersWorker,
  DeleteWishlistProductsJob: deleteWishlistProductsJob,
  DeleteExpiredOauthDeviceAuthorizationsJob: deleteExpiredOauthDeviceAuthorizationsJob,
  "Mcp::DeleteExpiredEventSubscriptionsJob": mcpDeleteExpiredEventSubscriptionsJob,
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
  TaxFormTransactionReportJob: taxFormTransactionReportJob,
  HandleNewBankAccountWorker: handleNewBankAccountWorker,
  DeleteGuardianStripePersonJob: deleteGuardianStripePersonJob,
  GenerateCommunityChatRecapJob: generateCommunityChatRecapJob,
  ReverseDeferredInternalTransferJob: reverseDeferredInternalTransferJob,
  GenerateSubscribePreviewJob: generateSubscribePreviewJob,
  ProductBuildUnpackJob: productBuildUnpackJob,
  StampPdfForPurchaseJob: stampPdfForPurchaseJob,
  DeliverFilesReadyNotificationJob: deliverFilesReadyNotificationJob,
  CustomDomainVerificationWorker: customDomainVerificationWorker,
  "Exports::AffiliateExportWorker": affiliateExportWorker,
  "Exports::AudienceExportWorker": audienceExportWorker,
  "Exports::Sales::CompileChunksWorker": compileChunksWorker,
  "Exports::Sales::ProcessChunkWorker": processChunkWorker,
  AnnualPayoutExportWorker: annualPayoutExportWorker,
  CollectUnclaimedBalancesOfInactiveStripeAccountsJob: collectUnclaimedBalancesOfInactiveStripeAccountsJob,
  PostToPingEndpointsWorker: postToPingEndpointsWorker,
  ReconcileClientConfirmedChargeJob: reconcileClientConfirmedChargeJob,
  SendPostBlastEmailsJob: sendPostBlastEmailsJob,
  SubmitPaypalDisputeEvidenceJob: submitPaypalDisputeEvidenceJob,
  RefundPurchaseForFraudWorker: refundPurchaseForFraudWorker,
  ExportPayoutData: exportPayoutData,
  ReissueSslCertificateForUpdatedCustomDomains: reissueSslCertificateForUpdatedCustomDomains,
  GenerateSslCertificate: generateSslCertificate,
  TranscodeVideoForStreamingWorker: transcodeVideoForStreamingWorker,
  BackfillMembershipRenewalRemindersJob: backfillMembershipRenewalRemindersJob,
  UnstickStuckInProgressPurchasesJob: unstickStuckInProgressPurchasesJob,
  GenerateMerchantCenterFeedWorker: generateMerchantCenterFeedWorker,
  SyncGuardianToStripeJob: syncGuardianToStripeJob,
  DuplicateProductWorker: duplicateProductWorker,
  GenerateFinancialReportsForPreviousQuarterJob: generateFinancialReportsForPreviousQuarterJob,
  GenerateFinancialReportsForPreviousMonthJob: generateFinancialReportsForPreviousMonthJob,
  ReconcilePendingPaypalRefundsJob: reconcilePendingPaypalRefundsJob,
  SendWorkflowEmailsToPastCanceledMembersJob: sendWorkflowEmailsToPastCanceledMembersJob,
  DispatchPendingPartnerMigrationNotificationsJob: dispatchPendingPartnerMigrationNotificationsJob,
  DispatchProductPublishSchedulesJob: dispatchProductPublishSchedulesJob,
  PublishScheduledProductJob: publishScheduledProductJob,
  PartnerMigrationNotificationJob: partnerMigrationNotificationJob,
  ResumeStalledPartnerMigrationsJob: resumeStalledPartnerMigrationsJob,
  PartnerMigrationImportJob: partnerMigrationImportJob,
  RetryStripeRejectedPayoutSetupForSellerJob: retryStripeRejectedPayoutSetupForSellerJob,
  SendWorkflowEmailToOpenedNonClickerJob: sendWorkflowEmailToOpenedNonClickerJob,
  ScheduleOpenedNoClickWorkflowEmailsJob: scheduleOpenedNoClickWorkflowEmailsJob,
  SendProductPublishScheduleNoticeJob: sendProductPublishScheduleNoticeJob,
  "PurchaseRefundRequests::EscalateOverdueJob": purchaseRefundRequestsEscalateOverdueJob,
  RecordUtmLinkVisitJob: recordUtmLinkVisitJob,
  "Mcp::DeliverEventJob": mcpDeliverEventJob,
  "Exports::Sales::CreateAndEnqueueChunksWorker": createAndEnqueueChunksWorker,
  SendBundlesMarketingEmailJob: sendBundlesMarketingEmailJob,
  GenerateAvatarVariantJob: generateAvatarVariantJob,
  AlertOnStaleBlocksHoldingEstablishedBuyersJob: alertOnStaleBlocksHoldingEstablishedBuyersJob,
  AlertSellersOfUndeliveredReceiptsJob: alertSellersOfUndeliveredReceiptsJob,
  ReconcileStripePayoutsPausesJob: reconcileStripePayoutsPausesJob,
  ReconcileStripePayoutsPauseForSellerJob: reconcileStripePayoutsPauseForSellerJob,
  SendPostBlastEmailsSliceJob: sendPostBlastEmailsSliceJob,
  SendStripeBalanceCheckNotificationJob: sendStripeBalanceCheckNotificationJob,
  VerifyFinanceReportsDeliveryJob: verifyFinanceReportsDeliveryJob,
  SweepClosedSellerConnectAccountsJob: sweepClosedSellerConnectAccountsJob,
  AlertOnStripeDobDriftJob: alertOnStripeDobDriftJob,
};

// `sidekiq_retry_in` and `sidekiq_retries_exhausted` blocks of ported jobs, keyed by Ruby class name.
// The worker refuses to start when a ported job defines one in Ruby and has none here.
export const JOB_RETRY_IN: Record<string, RetryIn> = {
  LiftPlatformStripePauseJob: liftPlatformStripePauseJobRetryIn,
  SubmitPaypalDisputeEvidenceJob: submitPaypalDisputeEvidenceJobRetryIn,
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
  TaxFormTransactionReportJob: taxFormTransactionReportJobRetriesExhausted,
  HandleNewBankAccountWorker: handleNewBankAccountWorkerRetriesExhausted,
  DeleteGuardianStripePersonJob: deleteGuardianStripePersonJobRetriesExhausted,
  GenerateCommunityChatRecapJob: generateCommunityChatRecapJobRetriesExhausted,
  ReverseDeferredInternalTransferJob: reverseDeferredInternalTransferJobRetriesExhausted,
  GenerateSubscribePreviewJob: generateSubscribePreviewJobRetriesExhausted,
  PerformPayoutsForUserSliceWorker: performPayoutsForUserSliceWorkerRetriesExhausted,
  PerformPayoutsUpToDelayDaysAgoWorker: performPayoutsUpToDelayDaysAgoWorkerRetriesExhausted,
  GenerateFinancialReportsForPreviousQuarterJob: generateFinancialReportsForPreviousQuarterJobRetriesExhausted,
  GenerateFinancialReportsForPreviousMonthJob: generateFinancialReportsForPreviousMonthJobRetriesExhausted,
  GenerateSslCertificate: generateSslCertificateRetriesExhausted,
  PartnerMigrationImportJob: partnerMigrationImportJobRetriesExhausted,
};
