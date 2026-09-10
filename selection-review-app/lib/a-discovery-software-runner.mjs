import { runLinkfoxReadSoftwareJob } from './linkfox-read-job-runner.mjs';
import { runSeerfarDiscoverySoftwareJob } from './seerfar-discovery-software-runner.mjs';

export function runADiscoverySoftwareJob(input) {
  if (input.connectorBinding?.provider === 'seerfar') return runSeerfarDiscoverySoftwareJob(input);
  return runLinkfoxReadSoftwareJob({...input,kind:'discovery'});
}
