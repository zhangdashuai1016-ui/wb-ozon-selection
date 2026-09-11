import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { createLatestRead, createSelectionGuard, runMutation, shouldContinuePolling, errorMessage, candidatePlatform } from "./formState.js";
import { validateCandidateCommentReceipt } from "./commentInput.js";
import { startQueuedSupplierCapture } from "./captureStart.js";
import { firstInQueue, matchesQueue } from "./candidateViews";
import AddCandidateModal from "./components/AddCandidateModal";
import CandidateDetail, { CandidateReview } from "./components/CandidateDetail";
import CandidateRail from "./components/CandidateRail";
import DailyProgress from "./components/DailyProgress";
import { PlusIcon } from "./components/Icons";
import QueueTabs from "./components/QueueTabs";
import OperatingRules from "./components/OperatingRules";
import ProcessingBreakdown from "./components/ProcessingBreakdown";
import RuntimeArchitectureStatus from "./components/RuntimeArchitectureStatus";
import LocalOwnerAccessPanel from "./components/LocalOwnerAccessPanel.jsx";
import OzonAccountPreparationCard from './components/OzonAccountPreparationCard.jsx';
import ProductDiscoveryCard from './components/ProductDiscoveryCard.jsx';
import ProductDetailPreparationCard from './components/ProductDetailPreparationCard.jsx';
import Phase2ASimulation from "./components/Phase2ASimulation";
import UserInspector from "./components/UserInspector";
import ThreeStoreMap from "./components/ThreeStoreMap";
import SelectionDesk from "./components/SelectionDesk.jsx";
import PipelineBoard from "./components/PipelineBoard.jsx";
import OwnerInbox from "./components/OwnerInbox.jsx";
import ProductPage from "./components/ProductPage.jsx";
import { DESK_STORES, deskCounts, discoveredTitleZh, shortProductTitle, storeLabel } from "./selectionDeskView.js";
import {
  EXTENSION_STATUS_PING,
  EXTENSION_STATUS_RESPONSE,
  EXTENSION_STATUS_RESPONSE_TIMEOUT_MS,
  extensionConnectionStatus,
  readCachedExtensionVersion
} from "./extensionStatus";

const INITIAL_QUEUE = "codex_processing";
/** The owner's own pages plus the maintenance list; every older page stays reachable under 维护. */
const DESK_VIEWS = ["desk", "board", "inbox", "maint"];
/** Views that read the saved query results, so the read keeps running while the owner is on any of them. */
const DISCOVERY_VIEWS = ["discovery", "desk", "product"];
/** Views whose product links open one product page. */
const CANDIDATE_LINK_VIEWS = ["discovery", "desk", "board", "inbox", "product"];
const MAINTENANCE_PAGES = [
  { view: "review", label: "今日选品评审" },
  { view: "discovery", label: "软件找商品" },
  { view: "accounts", label: "账户准备" },
  { view: "map", label: "全店能力地图" },
  { view: "phase2a", label: "第2A模拟验收" }
];
const VIEW_TITLES = { desk: "选品台", board: "进行中", inbox: "需要你处理", maint: "维护", product: "商品",
  map: "全店能力地图", phase2a: "第2A模拟验收", accounts: "账户准备", discovery: "软件找商品", review: "今日选品评审" };
export default function App() {
  const [state, setState] = useState({
    candidates: [],
    meta: null,
    rules: null,
    summary: null,
    seerfarRuntime: null,
    extensionHeartbeat: null,
    runtimeArchitecture: null,
    captureControl: { status: "idle", label: "商品采集控制空闲" }
  });
  const [selectedId, setSelectedId] = useState("");
  const [queue, setQueue] = useState(INITIAL_QUEUE);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const readFailed = useRef(false);
  const selectionGuard = useRef(createSelectionGuard());
  // The owner lands on 选品台; the older pages keep their behaviour and stay reachable under 维护.
  const [view, setView] = useState("desk");
  const [deskStore, setDeskStore] = useState("miska");
  const [skippedProducts, setSkippedProducts] = useState([]);
  const [threeStoreMap, setThreeStoreMap] = useState(null);
  const [accountPreparationView,setAccountPreparationView]=useState(null);
  const [accountPreparationError,setAccountPreparationError]=useState(null);
  const [accountRefresh,setAccountRefresh]=useState(0);
  const accountReads=useRef(createLatestRead());
  const accountOwner=state.runtimeArchitecture?.currentUser?.authenticated===true&&state.runtimeArchitecture.currentUser.roles.includes('owner');
  const accountOwnerId=accountOwner?state.runtimeArchitecture.currentUser.userId:null;
  const accountContext=useRef(null);
  accountContext.current={ownerId:accountOwnerId,view};
  useEffect(()=>{
    setAccountPreparationView(null);setAccountPreparationError(null);
    if(view!=='accounts'||!accountOwner)return undefined;
    const controller=new AbortController();
    accountReads.current.run(api.getAccountPreparations,setAccountPreparationView,{signal:controller.signal})
      .catch(error=>{if(!controller.signal.aborted)setAccountPreparationError(error.message);});
    return ()=>{controller.abort();accountReads.current.cancel();};
  },[view,accountOwnerId,accountRefresh]);
  async function runAccountPreparation(action,payload) {
    const ownerId=accountOwnerId;
    return accountReads.current.run(()=>action(payload),result=>{
      if(accountContext.current.ownerId===ownerId&&accountContext.current.view==='accounts')setAccountPreparationView(result);
    },{protect:true});
  }
  const [discoveryView,setDiscoveryView]=useState(null);
  const [discoveryError,setDiscoveryError]=useState(null);
  const [discoveryRefresh,setDiscoveryRefresh]=useState(0);
  const discoveryReads=useRef(createLatestRead());
  useEffect(()=>{
    setDiscoveryView(null);setDiscoveryError(null);
    if(!DISCOVERY_VIEWS.includes(view)||!accountOwner)return undefined;
    const controller=new AbortController();let timer;
    async function read(){
      try{
        const next=await discoveryReads.current.run(api.getProductDiscovery,setDiscoveryView,{signal:controller.signal});
        if(!controller.signal.aborted&&next?.batches.some(entry=>entry.jobs.some(({job})=>['queued','claimed','waiting_platform'].includes(job.status)))) {
          timer=window.setTimeout(read,3000);
        }
      }catch(error){if(!controller.signal.aborted)setDiscoveryError(error.message);}
    }
    read();
    return ()=>{controller.abort();window.clearTimeout(timer);discoveryReads.current.cancel();};
  },[view,accountOwnerId,discoveryRefresh]);
  /**
   * Every discovery write goes through here and never through the read guard: the guard drops its result whenever a
   * refresh or a view switch happens mid-flight, which is how a confirmed round reached the server and was reported to
   * the owner as "没有创建成功" (2026-09-11). The server's answer is always returned; only publishing it is conditional.
   */
  async function mutateProductDiscovery(action,payload){
    const ownerId=accountOwnerId;
    const current=()=>accountContext.current.ownerId===ownerId&&DISCOVERY_VIEWS.includes(accountContext.current.view);
    return runMutation(()=>action(payload),{reads:discoveryReads.current,isCurrent:current,publish(next){
      setDiscoveryView(next);setDiscoveryRefresh(value=>value+1);
    }});
  }
  /**
   * The 找货 step of one product. Opening it derives the market snapshot from the already-saved query receipt and
   * recomputes the estimate on the server; the page itself starts no work and reads no platform.
   */
  const [productDraftView,setProductDraftView]=useState(null);
  const [productDraftError,setProductDraftError]=useState(null);
  const [productDraftRefresh,setProductDraftRefresh]=useState(0);
  const productDraftReads=useRef(createLatestRead());
  // Switching products clears the previous product's draft; a refresh of the same product keeps what is on screen.
  useEffect(()=>{setProductDraftView(null);},[selectedId]);
  useEffect(()=>{
    setProductDraftError(null);
    if(view!=='product'||!accountOwner||!selectedId)return undefined;
    const controller=new AbortController();
    productDraftReads.current.run(signal=>api.getSupplierDraft(selectedId,signal),setProductDraftView,{signal:controller.signal})
      .catch(error=>{if(!controller.signal.aborted)setProductDraftError(errorMessage(error));});
    return ()=>{controller.abort();productDraftReads.current.cancel();};
  },[view,accountOwnerId,selectedId,productDraftRefresh]);
  async function runProductStep(action,payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const result=await productDraftReads.current.run(()=>action(candidateId,payload),next=>{
      if(accountContext.current.ownerId===ownerId&&accountContext.current.view==='product'&&next?.supplierDraftV1!==undefined){
        setProductDraftView(next);
      }
    },{protect:true});
    await load(true);
    setProductDraftRefresh(value=>value+1);
    return result;
  }
  /**
   * 申请插件采集 on the product page. Two things separate it from runProductStep: the write never passes through the
   * read guard (a cancelled read would hide the server's real answer — the same class of error r13 fixed), and the
   * queued receipt is followed by the page→content-script start signal. The extension background only keeps a
   * heartbeat and never polls for jobs, so without that signal the job can only sit until it expires, which is exactly
   * what the owner saw four times on 2026-09-11. The returned sentence is what the page shows in its own notice slot.
   */
  async function requestProductCapture(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.confirmRealAStage(candidateId,payload),{
        reads:productDraftReads.current,isCurrent:current,
        publish(next){if(next?.supplierDraftV1!==undefined)setProductDraftView(next);}
      });
      const start=await startQueuedSupplierCapture(result);
      if(start)return start.message;
      return result?.status==="supplier_capture_job_queued"
        ? "这件商品已经有一个还在等待的采集作业，这次没有重新创建；等它结束后再申请，软件不会自动重试"
        : "已提交A阶段确认，这次没有创建采集作业；请看上面的采集状态";
    // Whatever happened — accepted, refused by the extension, or refused by the server — the page then shows the state
    // the server actually holds, so a rejection is never read off a stale card.
    }finally{await load(true);setProductDraftRefresh(value=>value+1);}
  }
  const [extensionStatus, setExtensionStatus] = useState(() => extensionConnectionStatus({
    cachedVersion: readCachedExtensionVersion()
  }));
  const effectiveExtensionStatus = useMemo(() => {
    // The page bridge answered for this exact tab, so its verdict wins; only an unanswered ping falls back to the heartbeat.
    if (["connected", "background_unavailable", "reload_required"].includes(extensionStatus.code)) {
      return extensionStatus;
    }
    return extensionConnectionStatus({
      cachedVersion: readCachedExtensionVersion(),
      serverHeartbeat: state.extensionHeartbeat
    });
  }, [extensionStatus, state.extensionHeartbeat]);

  useEffect(() => {
    let responseTimer;
    let liveVersion = "";
    let pendingNonce = "";
    function ping() {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingNonce = nonce;
      window.postMessage({ type: EXTENSION_STATUS_PING, nonce }, window.location.origin);
      window.clearTimeout(responseTimer);
      responseTimer = window.setTimeout(() => {
        liveVersion = "";
        setExtensionStatus(extensionConnectionStatus({ cachedVersion: readCachedExtensionVersion() }));
      }, EXTENSION_STATUS_RESPONSE_TIMEOUT_MS);
    }
    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== EXTENSION_STATUS_RESPONSE) return;
      if (event.data?.nonce !== pendingNonce) return;
      liveVersion = String(event.data.version || "").trim();
      window.clearTimeout(responseTimer);
      setExtensionStatus(extensionConnectionStatus({
        liveVersion,
        backgroundReady: event.data.backgroundReady === true
      }));
    }
    window.addEventListener("message", onMessage);
    ping();
    const interval = window.setInterval(ping, 10000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(responseTimer);
    };
  }, []);

  const latestRead = useRef(createLatestRead());
  const ownerPermissionsKnown = useRef(false);
  const currentView = useRef({ queue, sourceFilter });
  currentView.current = { queue, sourceFilter };

  const load = useCallback(async (quiet = false, { protect = false, signal } = {}) => {
    try {
      const next = await latestRead.current.run(api.getState, (value) => {
        readFailed.current = false;
        if (protect) ownerPermissionsKnown.current = true;
        setState((current) => ({ ...value, seerfarRuntime: current.seerfarRuntime,
          runtimeArchitecture: value.runtimeArchitecture && !ownerPermissionsKnown.current
            ? { ...value.runtimeArchitecture, currentUser: null } : value.runtimeArchitecture }));
      }, { protect, signal });
      if (!next || signal?.aborted) return null;
      const { queue, sourceFilter } = currentView.current;
      setSelectedId((currentId) => {
        const current = next.candidates.find((candidate) => candidate.id === currentId);
        if (current && matchesQueue(current, queue, sourceFilter)) return currentId;
        return firstInQueue(next.candidates, queue, sourceFilter)?.id || "";
      });
      if (!quiet) setLoading(false);
      return next;
    } catch (error) {
      if (signal?.aborted) return null;
      readFailed.current = true;
      setNotice({ type: "error", message: `读取共享数据失败，轮询已暂停；点击“刷新数据”恢复：${error.message}` });
      if (!quiet) setLoading(false);
      return null;
    }
  }, []);

  const clearOwnerPermissions = useCallback(() => {
    ownerPermissionsKnown.current = false;
    latestRead.current.cancel();
    setState(current => ({ ...current, runtimeArchitecture: current.runtimeArchitecture ? { ...current.runtimeArchitecture, currentUser: null } : null }));
  }, []);
  const refreshOwnerPermissions = useCallback(async (access, { signal } = {}) => {
    clearOwnerPermissions();
    const next = await load(true, { protect: true, signal });
    if (!next && !signal?.aborted) throw new Error("主人登录状态已读取，但当前业务权限回读失败；请重新读取登录状态。");
  }, [clearOwnerPermissions, load]);

  useEffect(() => () => latestRead.current.cancel(), []);
  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();
    async function poll() {
      if (!shouldContinuePolling({ active, failed: readFailed.current })) return;
      await load(true, { signal: controller.signal });
      if (!active) return;
      setLoading(false);
      if (shouldContinuePolling({ active, failed: readFailed.current })) timer = window.setTimeout(poll, 3000);
    }
    poll();
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [load, pollEpoch]);

  useEffect(() => {
    if (!notice || notice.type === "error") return undefined;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(
    () => state.candidates.find((candidate) => candidate.id === selectedId) || null,
    [state.candidates, selectedId]
  );
  const [productDetailView,setProductDetailView]=useState(null);
  const [productDetailError,setProductDetailError]=useState(null);
  const [productDetailRefresh,setProductDetailRefresh]=useState(0);
  const productDetailReads=useRef(createLatestRead());
  const detailCandidateId=selected?.aDiscoveryEvidenceV1?selected.id:null;
  const detailRevision=selected?.dataRevision;
  const detailContext=useRef(null);
  detailContext.current={candidateId:detailCandidateId,revision:detailRevision,ownerId:accountOwnerId,view};
  useEffect(()=>{
    setProductDetailView(null);setProductDetailError(null);
    if(view!=='review'||!accountOwnerId||!detailCandidateId)return undefined;
    const controller=new AbortController();let timer;
    async function read() {
      try {
        const next=await productDetailReads.current.run(signal=>api.getProductDetails(detailCandidateId,detailRevision,signal),setProductDetailView,{signal:controller.signal});
        if(!controller.signal.aborted&&next?.jobs.some(({job})=>['queued','claimed','waiting_platform'].includes(job.status)))timer=window.setTimeout(read,3000);
      }catch(error){
        if(controller.signal.aborted)return;
        if(error.status===409&&error.body?.code==='CANDIDATE_CHANGED') {
          await load(true,{signal:controller.signal});
        }else setProductDetailError(error.message);
      }
    }
    read();
    return ()=>{controller.abort();window.clearTimeout(timer);productDetailReads.current.cancel();};
  },[view,accountOwnerId,detailCandidateId,detailRevision,productDetailRefresh,load]);
  async function runProductDetails(action,payload) {
    if(!selected||selected.id!==payload.candidateId||selected.dataRevision!==payload.expectedRevision)throw new Error('商品或版本已变化，请重新读取详情准备。');
    const context=detailContext.current;
    try {
      const result=await productDetailReads.current.run(()=>action(payload),next=>{
        if(detailContext.current.candidateId===context.candidateId&&detailContext.current.revision===context.revision&&
          detailContext.current.ownerId===context.ownerId&&detailContext.current.view===context.view)setProductDetailView(next);
      },{protect:true});
      await load(true);
      return result;
    }finally{
      if(detailContext.current.candidateId===context.candidateId&&detailContext.current.ownerId===context.ownerId)setProductDetailRefresh(value=>value+1);
    }
  }

  const loadThreeStoreMap = useCallback(async () => {
    try {
      const next = await api.getThreeStoreMap();
      setThreeStoreMap(next);
      return next;
    } catch (error) {
      setNotice({ type: "error", message: `读取全店能力地图失败：${error.message}` });
      return null;
    }
  }, []);

  useEffect(() => {
    if (view === "map") loadThreeStoreMap();
  }, [view, loadThreeStoreMap]);

  function openQueue(nextQueue, preferredId = "", nextSourceFilter = sourceFilter) {
    selectionGuard.current.changed();
    if (["eliminated", "listed"].includes(nextQueue)) nextSourceFilter = "all";
    currentView.current = { queue: nextQueue, sourceFilter: nextSourceFilter };
    setQueue(nextQueue);
    setSourceFilter(nextSourceFilter);
    const preferred = state.candidates.find(
      (candidate) =>
        candidate.id === preferredId && matchesQueue(candidate, nextQueue, nextSourceFilter)
    );
    setSelectedId(
      preferred?.id || firstInQueue(state.candidates, nextQueue, nextSourceFilter)?.id || ""
    );
  }

  function navigateResult(candidate, token) {
    if (!selectionGuard.current.isCurrent(token)) return;
    currentView.current = { queue: candidate.workflowStatus, sourceFilter: "all" };
    setQueue(candidate.workflowStatus);
    setSourceFilter("all");
    setSelectedId(candidate.id);
  }
  async function openDiscoveredCandidate(candidateId){
    const ownerId=accountOwnerId;
    const next=await load(true);
    if(accountContext.current.ownerId!==ownerId||!CANDIDATE_LINK_VIEWS.includes(accountContext.current.view))return;
    const candidate=next?.candidates.find(value=>value.id===candidateId);
    if(!candidate){
      setDiscoveryError('候选未能从当前保存记录回读，请刷新核对。');
      setNotice({type:'error',message:'这件商品没能从当前保存记录里读出来，请刷新数据后再打开。'});
      return;
    }
    selectionGuard.current.changed();
    currentView.current={queue:candidate.workflowStatus,sourceFilter:'all'};
    // The desk, the board and the inbox all open the owner-facing product page; the old A card stays under 维护.
    setQueue(candidate.workflowStatus);setSourceFilter('all');setSelectedId(candidateId);setView('product');
  }

  async function addCandidate(payload) {
    const navigationToken = selectionGuard.current.capture();
    try {
      const result = await api.addCandidate(payload);
      setAddOpen(false);
      navigateResult(result.candidate, navigationToken);
      setNotice({
        type: "success",
        message: `${result.candidate.id} 已保存到软件状态机，当前等待A阶段方向判断；未唤醒Codex任务`
      });
      await load(true);
    } catch (error) {
      if (error.body?.duplicateId) {
        const nextState = await load(true);
        const duplicate = nextState?.candidates.find((candidate) => candidate.id === error.body.duplicateId);
        if (duplicate) navigateResult(duplicate, navigationToken);
        setAddOpen(false);
        setNotice({ type: "warning", message: `${error.message}，已跳转已有候选` });
        return;
      }
      throw error;
    }
  }

  async function updateSelected(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.updateCandidate(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({ type: "success", message: result.dispatch ? "资料已保存，并已进入受控异常处理" : "资料已保存；软件状态机未唤醒Codex，停止状态也没有被自动重启" });
      await load(true);
    } catch (error) {
      if (error.body?.duplicateId) {
        const nextState = await load(true);
        const duplicate = nextState?.candidates.find((candidate) => candidate.id === error.body.duplicateId);
        if (duplicate) navigateResult(duplicate, navigationToken);
        setNotice({ type: "warning", message: `${error.message}，已跳转已有候选` });
      } else {
        setNotice({ type: "error", message: errorMessage(error) });
        if (error.status === 409) await load(true);
        throw error;
      }
    }
  }

  async function confirmRealAStage(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.confirmRealAStage(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      // Same receipt, same start signal as before; only the sentence now comes from the shared ACK-code mapping.
      const captureStart = await startQueuedSupplierCapture(result);
      navigateResult(result.candidate, navigationToken);
      setNotice({
        type: "success",
        message: payload.decision === "reject"
          ? "A阶段已淘汰当前商品；未启动B或任何平台操作"
          : result.status === "supplier_capture_job_queued"
            ? captureStart
              ? `A阶段供应链接已保存；${captureStart.message}`
              : "A阶段供应链接已保存；这件商品已经有一个还在等待的采集作业，这次没有重新创建，系统不会自动重试"
          : result.candidate.lifecycleV11?.skuPackage?.businessPhase === "C1"
            ? "A确认已原子保存，B已自动通过并创建C1；无需再次点击开始上架准备"
            : "A确认已原子保存，B已自动计算；当前商品未进入C1"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 422 && error.body?.guooRouteComparison?.candidateId === selected.id) await load(true);
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function chooseRecoveryAction(action) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.chooseRecoveryAction(selected.id, {
        dataRevision: selected.dataRevision,
        action
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已按固定处理方式交给${result.dispatch.assigneeTitle || "当前负责人"}；再次真实失败仍会停止`
          : "已记录为保持停止，系统不会自动重试"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function evaluateSelected(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const previousId = selected.id;
      const result = await api.saveUserEvaluation(previousId, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      setNotice({
        type: "success",
        message:
          payload.decision === "reject"
            ? "已淘汰；不会自动补充新候选"
            : "该旧判断入口已停止执行；新版商品请使用A阶段完整确认卡"
      });
      const nextState = await load(true);
      if (selectionGuard.current.isCurrent(navigationToken)) {
        const current = currentView.current;
        const next = firstInQueue(nextState?.candidates || [], "awaiting_user_direction", current.sourceFilter, previousId);
        if (current.queue === "awaiting_user_direction" && next) setSelectedId(next.id);
        else navigateResult(result.candidate, navigationToken);
      }
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function commentSelected(input) {
    const { candidateId, ...request } = input || {};
    if (!selected || selected.id !== candidateId) {
      throw new Error("当前候选已变化；留言内容仍保留，请刷新后重新提交。");
    }
    try {
      const result = validateCandidateCommentReceipt(input, await api.addComment(candidateId, request));
      setNotice({
        type: "success",
        message:
          request.category === "elimination_feedback"
            ? "淘汰原因已保存，后续自动选品会读取这条避坑条件"
            : "留言已保存；普通留言不会启动或重试任务"
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function markSelectedListed(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const platform = candidatePlatform(selected);
      if (payload.platform !== platform || payload.store !== selected.targetStore) throw new Error("平台与当前目标店铺不一致，未保存。");
      const result = await api.markListed(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({ type: "success", message: "已移入“已上架”，复盘记录和上架信息均已保留" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function startSourceCapture(recoverySuggestion = "", mode = "") {
    if (!selected) return null;
    if (mode !== "listed_evidence_recovery" || selected.workflowStatus !== "listed") throw new Error("旧C阶段供应采集入口已退役；不得从C1/C2重新访问供应平台。");
    try {
      const result = await api.startSourceCapture(selected.id, {
        dataRevision: selected.dataRevision,
        recoverySuggestion,
        ...(mode ? { mode } : {})
      });
      setNotice({ type: "success", message: "已创建当前已上架商品的单次证据回补请求，等待后台认证领取；页面不接收或转发作业凭据。尚未证明采集已开始。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function startOzonSalesCapture() {
    if (!selected) return null;
    try {
      const result = await api.startOzonSalesCapture(selected.id, { dataRevision: selected.dataRevision });
      setNotice({ type: "success", message: "已提交当前商品的单次只读采集请求，等待后台认证领取；页面不转发凭据，也不把请求接受当作采集完成。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function selectSourceCaptureSku(sourceSkuIds, context) {
    if (!selected) return null;
    try {
      const result = await api.selectSourceCaptureSku(selected.id, {
        dataRevision: context.dataRevision,
        sourceSkuIds
      });
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已确认${sourceSkuIds.length}个1688 SKU，并且只向选品任务派发当前商品B阶段一次`
          : `已确认${sourceSkuIds.length}个1688 SKU；证据已保存，原上架记录保持不变且没有自动派发任务`
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function recalculateBWithExactCommission(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未复算旧商品。");
    try {
      const result = await api.recalculateBWithExactCommission(selected.id, payload);
      setNotice({ type: "success", message: result.result.status === "passed"
        ? "正式利润已通过，上架准备已接收该商品；供货确认保持不变。"
        : "正式利润未达到门槛，结果已保存；未进入上架准备。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function retryC1KeywordHandoff(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧交接。");
    try {
      const result = await api.retryC1KeywordHandoff(selected.id, payload);
      setNotice({ type: "success", message: "文案请求已准备，等待这一次付费许可；没有重复查询关键词。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function authorizeC1PaidDraft(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未提交旧许可。");
    try {
      const result = await api.authorizeC1PaidDraft(selected.id, payload);
      setNotice({ type: "success", message: "已取得本次许可和执行状态，请查看文案回执。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function continueSavedC1Draft(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧任务。");
    try {
      const result = await api.continueSavedC1Draft(selected.id, payload);
      setNotice({ type: "success", message: "已取得原任务的执行状态，请查看文案回执。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function saveC1RightsReview(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未提交旧声明。");
    try {
      const result = await api.saveC1RightsReview(selected.id, payload);
      setNotice({ type: "success", message: "本件商品的品牌与权利声明已保存，后续执行按当前证据判断。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function saveProductionOwnerDecision(payload) {
    if (!selected) return;
    try {
      const result = await api.saveProductionOwnerDecision(selected.id, payload);
      setNotice({ type: "success", message: "生产授权和任务已保存，请查看当前执行结果。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function saveFinalPricingReview(payload) {
    if (!selected || selected.id !== payload.candidateId) throw new Error("当前商品已变化，未提交旧定价复核。");
    try {
      const result = await api.saveFinalPricingReview(selected.id, payload);
      setNotice({ type: "success", message: result.pricingStatus === "price_unchanged"
        ? "最终市场比较已保存，价格仍引用有效的原利润版本。"
        : result.pricingStatus === "profit_rejected" ? "新价格的利润未通过，原资料已保留，未创建生产授权。"
          : "最终定价复核已保存，请查看新利润版本与后续资料状态。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function continueSavedDE(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧任务。");
    try {
      const result = await api.continueSavedDE(candidateId, payload);
      setNotice({ type: "success", message: "已取得原任务的执行状态，请查看生产与平台核验结果。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function runAccountRead(action, payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error('当前商品已变化，未提交旧的账户核验。');
    try {
      const result = await action(payload);
      setNotice({ type: 'success', message: '本次账户核验状态已保存，请查看取得的资料及剩余缺口。' });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function uploadLifecycleFinalAsset(file, context) {
    if (!selected) throw new Error("当前没有选中的商品");
    try {
      return await api.uploadLifecycleFinalAsset(selected.id, {
        dataRevision: context?.dataRevision ?? selected.dataRevision,
        draftRevision: context.draftRevision,
        file
      });
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function saveC2UploadDraft(payload) {
    if (!selected) throw new Error("当前没有选中的商品");
    return api.saveC2UploadDraft(selected.id, payload);
  }

  async function confirmLifecycleFinalAssets(payload) {
    if (!selected) return;
    try {
      await api.confirmLifecycleFinalAssets(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision,
        confirmed: true
      });
      setNotice({ type: "success", message: "最终素材及顺序已锁定，最终商品方案卡已生成；尚未生产授权，也没有店铺写入" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  function changeQueue(nextQueue) {
    openQueue(nextQueue);
  }

  function changeSourceFilter(nextFilter) {
    selectionGuard.current.changed();
    currentView.current = { queue, sourceFilter: nextFilter };
    setSourceFilter(nextFilter);
    setSelectedId(firstInQueue(state.candidates, queue, nextFilter)?.id || "");
  }

  if (loading) {
    return <div className="app-loading">正在打开全店经营工作台…</div>;
  }

  const counts = deskCounts({ discoveryView, candidates: state.candidates, store: deskStore });
  // The product page is read twice: once by the top bar, which names it and keeps the way back, once by the page itself.
  const productCandidate = view === "product" ? state.candidates.find(item => item.id === selectedId) ?? null : null;
  const productTitleZh = view === "product" ? discoveredTitleZh(discoveryView, productCandidate) : null;
  const deskNav = [
    { view: "desk", label: "选品台", count: counts.desk },
    { view: "board", label: "进行中", count: counts.board },
    { view: "inbox", label: "需要你处理", count: counts.inbox },
    { view: "maint", label: "维护", count: null }
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <h1>选品台</h1>
          {view === "product"
            ? <p className="app-brand-product">商品 · {shortProductTitle(productCandidate, productTitleZh)}
              <button type="button" className="app-brand-back" onClick={() => setView("desk")}>← 选品台</button></p>
            : <p>{VIEW_TITLES[view] ?? "今日选品评审"}</p>}
        </div>
        <nav className="desk-nav" aria-label="主要页面">
          {deskNav.map(item => <button key={item.view} type="button" className={`button ${view === item.view ? "primary" : "secondary"}`}
            onClick={() => setView(item.view)}>
            {item.label}{item.count === null || item.count === 0 ? null : <span className="desk-badge">{item.count}</span>}
          </button>)}
          <label className="desk-store-switch">店铺
            <select value={deskStore} onChange={event => setDeskStore(event.target.value)} aria-label="选择店铺">
              {DESK_STORES.map(store => <option key={store} value={store}>{storeLabel(store)}</option>)}
            </select>
          </label>
        </nav>
        <div className="header-actions">
          <RuntimeArchitectureStatus status={state.runtimeArchitecture} />
          <span className={`extension-status ${effectiveExtensionStatus.code}`} data-testid="extension-status">
            <i aria-hidden="true" />{effectiveExtensionStatus.label}
          </span>
          <span className={`capture-control-status ${state.captureControl?.status || "idle"}`} data-testid="capture-control-status">
            <i aria-hidden="true" />{state.captureControl?.label || "商品采集控制状态未取得"}
          </span>
          <button type="button" className="button primary" onClick={() => setView("discovery")}>找一轮新品</button>
          <button type="button" className="button secondary" onClick={() => { readFailed.current = false; setNotice(null); setPollEpoch(epoch => epoch + 1); }}>刷新数据</button>
          <button type="button" className="button add-button" onClick={() => setAddOpen(true)}>
            <PlusIcon /> 添加我找到的商品
          </button>
        </div>
      </header>
      <LocalOwnerAccessPanel onAccessResolved={refreshOwnerPermissions} onAccessUnknown={clearOwnerPermissions} />
      {notice ? <div role={notice.type === "error" ? "alert" : "status"} className={`global-notice ${notice.type}`}>{notice.message}</div> : null}

      {DESK_VIEWS.includes(view) ? (
        view === "desk" ? (
          <SelectionDesk
            discoveryView={discoveryView}
            candidates={state.candidates}
            store={deskStore}
            ownerReady={accountOwner}
            loadingLabel={discoveryError ? `读取本店查询结果失败：${discoveryError}` : "正在读取本店的查询结果…"}
            skipped={skippedProducts}
            onSelectProduct={payload => mutateProductDiscovery(api.selectProductDiscovery, payload)}
            onDeclineProduct={payload => mutateProductDiscovery(api.declineProductDiscovery, payload)}
            onLaterProduct={row => setSkippedProducts(current => current.includes(row.key) ? current : [...current, row.key])}
            onEstimate={payload => mutateProductDiscovery(api.estimateProductDiscovery, payload)}
            onTranslate={payload => mutateProductDiscovery(api.translateProductDiscovery, payload)}
            onOpenCandidate={openDiscoveredCandidate}
            onStartNewRound={({ plan, binding, store }) =>
              // One explicit confirmation on the desk, one request: the server creates, authorizes and starts the round
              // in one saved transaction, so a dropped answer can never leave a paid batch that was never started.
              mutateProductDiscovery(api.startProductDiscovery, { planId: plan.planId, planVersion: plan.version, targetStore: store,
                bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
                expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), idempotencyKey: `desk-round:${crypto.randomUUID()}` })}
            onResumeRound={({ batchId, expectedRevision }) =>
              // An older click that created a batch without a permit: this authorizes that same batch, never a new one.
              mutateProductDiscovery(api.authorizeProductDiscovery, { batchId, expectedRevision,
                expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), idempotencyKey: `desk-permit:${crypto.randomUUID()}` })}
            onOpenBoard={() => setView("board")}
            onOpenInbox={() => setView("inbox")}
          />
        ) : view === "board" ? (
          <PipelineBoard candidates={state.candidates} store={deskStore} onOpenCandidate={openDiscoveredCandidate} />
        ) : view === "inbox" ? (
          <OwnerInbox candidates={state.candidates} store={deskStore} onOpenCandidate={openDiscoveredCandidate} />
        ) : (
          <div className="page-panel">
            <h2>维护</h2>
            <p>这些是以前的页面，行为没有变化。日常判断不需要打开它们。</p>
            <div className="maint-pages">
              {MAINTENANCE_PAGES.map(page => <button key={page.view} type="button" className="button secondary" onClick={() => setView(page.view)}>{page.label}</button>)}
            </div>
          </div>
        )
      ) : view === "product" ? (
        !accountOwner ? <div className="page-panel"><p role="status">请先登录主人身份后查看这件商品。</p></div> : <ProductPage
          candidate={productCandidate}
          view={productDraftView}
          titleZh={productTitleZh}
          extensionStatus={effectiveExtensionStatus}
          loadingLabel={productDraftError ? `读取这件商品的找货资料失败：${productDraftError}` : "正在读取这件商品的找货资料…"}
          onSaveDraft={payload => runProductStep(api.saveSupplierDraft, payload)}
          onRequestCapture={payload => requestProductCapture(payload)}
          onOpenLegacyCard={() => setView("review")}
          onBack={() => setView("desk")}
        />
      ) : view==='discovery'?<div className="page-panel">
        {!accountOwner?<p role="status">请先登录主人身份后查看商品发现计划。</p>:<>
          <button type="button" className="button secondary" onClick={()=>setDiscoveryRefresh(value=>value+1)}>刷新发现记录</button>
          {discoveryError?<p role="alert">读取发现记录失败：{discoveryError}</p>:discoveryView?
            <ProductDiscoveryCard view={discoveryView}
              onCreate={payload=>mutateProductDiscovery(api.createProductDiscovery,payload)}
              onAuthorize={payload=>mutateProductDiscovery(api.authorizeProductDiscovery,payload)}
              onContinue={payload=>mutateProductDiscovery(api.continueProductDiscovery,payload)}
              onSelect={payload=>mutateProductDiscovery(api.selectProductDiscovery,payload)}
              onTranslate={payload=>mutateProductDiscovery(api.translateProductDiscovery,payload)}
              onEstimate={payload=>mutateProductDiscovery(api.estimateProductDiscovery,payload)}
              onOpenCandidate={openDiscoveredCandidate}/>:<p role="status">正在读取当前发现计划和保存的批次…</p>}
        </>}
      </div>:view==='accounts'?<div className="page-panel">
        {!accountOwner?<p role="status">请先登录主人身份后查看账户准备。</p>:<>
          <button type="button" className="button secondary" onClick={()=>setAccountRefresh(value=>value+1)}>重新读取准备记录</button>
          {accountPreparationError?<p role="alert">读取账户准备失败：{accountPreparationError}</p>:accountPreparationView?
            <OzonAccountPreparationCard view={accountPreparationView}
              onCreate={payload=>runAccountPreparation(api.createAccountPreparation,payload)}
              onAuthorize={payload=>runAccountPreparation(api.authorizeAccountDiscovery,payload)}
              onContinue={payload=>runAccountPreparation(api.continueAccountDiscovery,payload)}
              onSelectWarehouse={payload=>runAccountPreparation(api.selectAccountWarehouse,payload)}/>:<p role="status">正在读取已保存的账户准备…</p>}
        </>}
      </div>:view === "phase2a" ? (
        <Phase2ASimulation onClose={() => setView("review")} />
      ) : view === "map" ? (
        <ThreeStoreMap
          map={threeStoreMap}
          onClose={() => setView("review")}
          onRefresh={loadThreeStoreMap}
        />
      ) : (
      <>

      <DailyProgress summary={state.summary} />
      <QueueTabs
        active={queue}
        counts={state.summary?.queueCounts}
        onChange={changeQueue}
      />
      <ProcessingBreakdown
        summary={state.summary}
        automationStarted={state.meta?.automationStarted}
      />

      <div className="workspace">
        <CandidateRail
          candidates={state.candidates}
          selectedId={selectedId}
          onSelect={(id) => { selectionGuard.current.changed(); setSelectedId(id); }}
          queue={queue}
          sourceFilter={sourceFilter}
          onSourceFilterChange={changeSourceFilter}
        />
        {selected ? (
          <div className="review-pane" key={selected.id}>
            {detailCandidateId?<>
              {!accountOwner?<p role="status">请先登录主人身份后查看本轮详情准备。</p>:<>
                <button type="button" className="button secondary" onClick={()=>setProductDetailRefresh(value=>value+1)}>重新读取详情准备</button>
                {productDetailError?<p role="alert">读取详情准备失败：{productDetailError}</p>:productDetailView?
                  <ProductDetailPreparationCard key={`${productDetailView.candidateId}:${productDetailView.revision}`} view={productDetailView}
                    onAuthorize={payload=>runProductDetails(api.authorizeProductDetails,payload)}
                    onContinue={payload=>runProductDetails(api.continueProductDetails,payload)}/>:<p role="status">正在读取已保存的详情准备…</p>}
              </>}
            </>:null}
            <CandidateDetail
              candidate={selected}
              seerfarRuntime={state.seerfarRuntime}
              onRealAConfirm={confirmRealAStage}
              onContinueSavedDE={continueSavedDE}
              onAuthorizeAccountRead={payload => runAccountRead(api.authorizeAccountRead, payload)}
              onContinueAccountRead={payload => runAccountRead(api.continueAccountRead, payload)}
            />
            <UserInspector
              candidate={selected}
              rules={state.rules}
              captureControl={state.captureControl}
              extensionStatus={effectiveExtensionStatus}
              onUpdate={updateSelected}
              onEvaluate={evaluateSelected}
              onComment={commentSelected}
              onMarkListed={markSelectedListed}
              onRecoveryAction={chooseRecoveryAction}
              onStartSourceCapture={startSourceCapture}
              onStartOzonSalesCapture={startOzonSalesCapture}
              onSelectSourceCaptureSku={selectSourceCaptureSku}
              onUploadLifecycleFinalAsset={uploadLifecycleFinalAsset}
              onSaveC2UploadDraft={saveC2UploadDraft}
              onConfirmLifecycleFinalAssets={confirmLifecycleFinalAssets}
              onSaveProductionOwnerDecision={saveProductionOwnerDecision}
              onSaveFinalPricingReview={saveFinalPricingReview}
              onSaveC1RightsReview={saveC1RightsReview}
              onAuthorizeC1PaidDraft={authorizeC1PaidDraft}
              onContinueSavedC1Draft={continueSavedC1Draft}
              onRetryC1KeywordHandoff={retryC1KeywordHandoff}
              onRecalculateBWithExactCommission={recalculateBWithExactCommission}
              productionIdentity={state.runtimeArchitecture?.currentUser}
            />
            <CandidateReview candidate={selected} />
          </div>
        ) : (
          <main className="candidate-detail empty-detail">这个队列暂时没有商品</main>
        )}
      </div>

      <OperatingRules rules={state.rules} />

      <footer className="boundary-footer">
        <div>A销售与供应方案确认 → B具体SKU利润 → 自动进入C1 → C2最终素材 → 生产确认；SKU独立生命周期。</div>
        <div>精确1688链接、供应SKU、货价、国内运费、采购成本、重量和尺寸在A阶段完成；B通过后由软件自动进入C1，不再要求主人点开始。上架任务只负责领域开发、验收与异常维护。</div>
        <div>失败立即停止且不自动重试。普通留言不会启动任务；生产写入必须另行确认价格、当前确认卡库存、素材和发布范围。</div>
      </footer>
      </>
      )}
      <AddCandidateModal open={addOpen} onClose={() => setAddOpen(false)} onSave={addCandidate} />
    </div>
  );
}
