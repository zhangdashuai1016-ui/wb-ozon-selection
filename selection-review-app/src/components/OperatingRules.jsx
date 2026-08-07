export default function OperatingRules() {
  return (
    <section className="operating-rules" aria-label="今日确认的选品与防空跑规则">
      <h2>今天确认的工作规则</h2>
      <div className="rule-grid">
        <p><strong>三阶段</strong>A方向初筛 → B具体SKU利润核算 → C采购/上架前来源与合规核验；SKU/链接不一致只拦当前SKU，不淘汰方向。</p>
        <p><strong>权利风险</strong>IP/品牌风险需总控确认；权利与合规核验未完成，不能进入待上架，更不能写店铺。</p>
        <p><strong>成本口径</strong>采购价固定为货价+国内运费的到手总价；促销20%/25%/30%只反推建议标价，不作为广告成本从折后成交价二次扣除。</p>
        <p><strong>蛋蛋鼠</strong>先用Seerfar做市场与利润方向，跨境商品份额至少40%；只有存在正采购空间的方向才继续找具体SKU。</p>
        <p><strong>Miska</strong>本周只审核用户提交品；累计5个完整、独立、利润通过样本后，只提交共同结构与最多3个扩散方向，仍需总控确认。</p>
        <p><strong>防空跑</strong>运行必须有runId、开始时间、当前步骤与最近实质进展；15分钟无新证据或步骤变化即停止，同轮同层同目标只允许一次读取。</p>
      </div>
    </section>
  );
}
