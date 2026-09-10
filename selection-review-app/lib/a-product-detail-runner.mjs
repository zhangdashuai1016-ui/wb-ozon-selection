import { runLinkfoxReadSoftwareJob } from './linkfox-read-job-runner.mjs';

export function runAProductDetailSoftwareJob(input) {
  return runLinkfoxReadSoftwareJob({...input,kind:'detail'});
}
