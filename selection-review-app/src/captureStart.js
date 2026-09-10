const REQUEST = "SELECTION_REVIEW_1688_CAPTURE_REQUEST";
const ACK = "SELECTION_REVIEW_1688_CAPTURE_ACK";

// Called only after this page receives the receipt for a newly created, explicit job.
export function requestSupplierCaptureStart(captureId, page = window) {
  if (typeof captureId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(captureId)) {
    throw new Error("本次采集作业编号无效");
  }
  return new Promise((resolve) => {
    const finish = (result) => {
      page.clearTimeout(timer);
      page.removeEventListener("message", receive);
      resolve(result);
    };
    const receive = (event) => {
      if (event.source !== page || event.origin !== page.location.origin ||
          event.data?.type !== ACK || event.data.captureId !== captureId) return;
      finish({ accepted: event.data.accepted === true });
    };
    page.addEventListener("message", receive);
    const timer = page.setTimeout(() => finish({ accepted: false }), 12000);
    page.postMessage({ type: REQUEST, captureId }, page.location.origin);
  });
}
