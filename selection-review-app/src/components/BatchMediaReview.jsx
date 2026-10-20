import EMediaReview from './EMediaReview.jsx';

/** Preserve the batch callback contract while sharing the evidence display. */
export default function BatchMediaReview({review,onConfirm}){
  return <EMediaReview review={review} merchantSku={review.scope?.sourceRecord.offerId??review.candidateId}
    onConfirm={onConfirm?input=>onConfirm(review.batchId,input):null}/>;
}
