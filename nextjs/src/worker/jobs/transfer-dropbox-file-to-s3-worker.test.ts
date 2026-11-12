// Replays transfer-dropbox-file-to-s3-worker.golden.json (scripts/golden/transfer-dropbox-file-to-s3-worker.rb): the job run by the real
// app as a Sidekiq job. Node sends the one `dropbox_files` read Rails sent and finishes a file that is no longer in progress; a file in
// progress is handed back before the first write.
import { loadGolden, replayJobGolden } from "./__fixtures__/replay-job-golden.ts";
import { transferDropboxFileToS3WorkerWith } from "./transfer-dropbox-file-to-s3-worker.ts";

const golden = loadGolden(new URL("./__fixtures__/transfer-dropbox-file-to-s3-worker.golden.json", import.meta.url));

// Rails raises for nil and casts a float or a word; Node hands those arguments back instead.
const castByRails = (value: unknown) =>
  !(typeof value === "number" && Number.isInteger(value)) &&
  !(typeof value === "string" && /^[0-9]{1,15}$/u.test(value));

replayJobGolden("TransferDropboxFileToS3Worker", golden, transferDropboxFileToS3WorkerWith(), (c) => castByRails(c.args[0]));
