import { LinkfoxDiscoveryError } from './linkfox-discovery-api.mjs';
import { LINKFOX_DETAIL_CONTRACT_VERSION, buildLinkfoxProductDetailRequest } from './linkfox-product-detail-api.mjs';
import { assertLinkfoxGatewayBinding, createLinkfoxGatewayTransport } from './linkfox-gateway-transport.mjs';
export function assertLinkfoxProductDetailBinding(binding) {
  const value=assertLinkfoxGatewayBinding(binding);
  if(value.contractVersion!==LINKFOX_DETAIL_CONTRACT_VERSION)throw new LinkfoxDiscoveryError('BINDING_INVALID');
  return value;
}
/** Separate per-job detail permission and budget; discovery credentials do not select a detail route. */
export function createLinkfoxProductDetailConnector(options) {
  const transport=createLinkfoxGatewayTransport({...options,binding:assertLinkfoxProductDetailBinding(options.binding)});
  return Object.freeze({read:input=>transport.request(buildLinkfoxProductDetailRequest(input))});
}
