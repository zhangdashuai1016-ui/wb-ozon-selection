import { LINKFOX_DISCOVERY_CONTRACT_VERSION, LinkfoxDiscoveryError, buildLinkfoxDiscoveryRequest } from './linkfox-discovery-api.mjs';
import { assertLinkfoxGatewayBinding, createLinkfoxGatewayTransport } from './linkfox-gateway-transport.mjs';
export function assertLinkfoxDiscoveryBinding(binding) {
  const value=assertLinkfoxGatewayBinding(binding);
  if(value.contractVersion!==LINKFOX_DISCOVERY_CONTRACT_VERSION)throw new LinkfoxDiscoveryError('BINDING_INVALID');
  return value;
}
/** One fresh transport for one persisted search job; no credentials are read during construction. */
export function createLinkfoxDiscoveryConnector(options) {
  const transport=createLinkfoxGatewayTransport({...options,binding:assertLinkfoxDiscoveryBinding(options.binding)});
  return Object.freeze({search:input=>transport.request(buildLinkfoxDiscoveryRequest(input))});
}
