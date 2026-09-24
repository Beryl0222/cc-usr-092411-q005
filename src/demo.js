import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReviewService } from "./review-service.js";
import { DomainRuleError } from "./errors.js";

/**
 * 验收演示（命令入口：npm run demo）
 *
 * 场景：
 *  1. 迟到利益关系 → 暂停原评分（留理由、不删记录）→ 异机构批准替补接管；
 *  2. 深度调查组 / 时政组两个组别独立排序、同时终局裁决；资格结论跨组复用、评分严格隔离；
 *  3. 公布后申诉（指向具体材料版本）→ 两名不同角色重评签署 → 追加更正后的最终序列；
 *  另含：重复请求/同编号异内容识别、两次崩溃恢复后按原截止时间继续回避确认与申诉、分数反查链。
 */

const LOG_PATH = fileURLToPath(new URL("../data/demo-event-log.jsonl", import.meta.url));
try { unlinkSync(LOG_PATH); } catch { /* 首次运行无文件 */ }

const INVEST = "INVEST"; // 深度调查组
const POLITICS = "POLITICS"; // 时政组
const GROUP_NAME = { INVEST: "深度调查组", POLITICS: "时政组" };

let clockMs = Date.parse("2026-09-20T09:00:00+08:00");
const now = () => new Date(clockMs).toISOString();
const advanceHours = (h) => { clockMs += h * 3600 * 1000; };
const stamp = () => now().replace("T", " ").replace(":00.000Z", "Z");

let sectionNo = 0;
function section(title) {
  sectionNo += 1;
  console.log(`\n${"=".repeat(78)}\n【${sectionNo}】${title}\n${"=".repeat(78)}`);
}
function ok(line) { console.log(`  ✓ ${line}`); }
function info(line) { console.log(`    · ${line}`); }
function fail(line) { console.log(`  ✗ 被拒绝：${line}`); }
function showRanking(groupId, ranking) {
  if (!ranking?.length) info(`${GROUP_NAME[groupId]} 无可排名序列`);
  else ranking.forEach((r, i) => info(`${GROUP_NAME[groupId]} 第 ${i + 1} 名：${r.candidateId}（均分 ${r.average}，${r.scoreCount} 个有效评分）`));
}

async function main() {
  // ============ 第 1 部分：初评登记后“崩溃” ============
  section("初评当日：安排两组截止时间、跨组兼报报名、材料第 1 版（随后进程退出）");
  let svc = await ReviewService.open({ filePath: LOG_PATH, now });
  svc.scheduleDeadline({ groupId: INVEST, recusalConfirmUntil: "2026-09-21T18:00:00+08:00", appealUntil: "2026-09-28T18:00:00+08:00", requestId: "deadline-invest-01" });
  svc.scheduleDeadline({ groupId: POLITICS, recusalConfirmUntil: "2026-09-21T18:00:00+08:00", appealUntil: "2026-09-28T18:00:00+08:00", requestId: "deadline-politics-01" });
  // C001 跨组兼报：同一候选人报两个组
  svc.acceptEntry({ candidateId: "C001-林某", name: "林某", groupIds: [INVEST, POLITICS], requestId: "entry-C001" });
  svc.acceptEntry({ candidateId: "C002-赵某", name: "赵某", groupIds: [INVEST] });
  svc.acceptEntry({ candidateId: "C003-钱某", name: "钱某", groupIds: [POLITICS] });
  for (const id of ["C001-林某", "C002-赵某", "C003-钱某"]) svc.submitMaterial({ candidateId: id, title: "代表作与任职说明", contentHash: `hash-${id}-v1` });
  await svc.flush();
  const beforeCrash = svc.events.length;
  console.log(`    · 已落盘 ${beforeCrash} 条事件到 ${LOG_PATH}`);

  // ============ 第 2 部分：恢复后继续回避确认 ============
  advanceHours(1);
  section("次日进程从事件日志恢复：状态与截止时间按原记录继续，随后分派评委、确认回避");
  svc = await ReviewService.open({ filePath: LOG_PATH, now });
  ok(`重放 ${svc.events.length} 条事件，状态完整恢复`);
  info(`恢复的截止时间（${GROUP_NAME[INVEST]}）：回避确认 ${svc.deadlines(INVEST).recusal_confirm_until}；申诉 ${svc.deadlines(INVEST).appeal_until}`);

  // 幂等：同编号同内容不重复生效
  svc.scheduleDeadline({ groupId: INVEST, recusalConfirmUntil: "2026-09-21T18:00:00+08:00", appealUntil: "2026-09-28T18:00:00+08:00", requestId: "deadline-invest-01" });
  const deadlineEvents = svc.events.filter((e) => e.event_type === "DEADLINE_SCHEDULED").length;
  ok(`同编号同内容重放：截止时间事件仍为 ${deadlineEvents} 条（幂等，不重复生效）`);
  // 同编号异内容：拒绝并留审计事件
  try {
    svc.scheduleDeadline({ groupId: INVEST, recusalConfirmUntil: "2026-09-22T18:00:00+08:00", appealUntil: "2026-09-28T18:00:00+08:00", requestId: "deadline-invest-01" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "CONFLICTING_REQUEST") fail(`同编号异内容（code=${e.code}），已追加 REQUEST_REJECTED 审计事件`);
    else throw e;
  }

  // R-周 受派前已申报与 C002 的利益关系：受派时被冻结进快照
  svc.declareInterest({ reviewerId: "R-周某", candidateId: "C002-赵某", detail: "两年前同属一个编辑组" });
  svc.assignReviewer({ groupId: INVEST, candidateId: "C001-林某", reviewerId: "R-王某", reviewerOrg: "甲通讯社" });
  svc.assignReviewer({ groupId: INVEST, candidateId: "C002-赵某", reviewerId: "R-周某", reviewerOrg: "乙报社" });
  const liAsg = svc.assignReviewer({ groupId: POLITICS, candidateId: "C001-林某", reviewerId: "R-李某", reviewerOrg: "乙报社" });
  svc.assignReviewer({ groupId: POLITICS, candidateId: "C003-钱某", reviewerId: "R-吴某", reviewerOrg: "甲通讯社" });
  const sunAsg = svc.assignReviewer({ groupId: POLITICS, candidateId: "C003-钱某", reviewerId: "R-孙某", reviewerOrg: "丙周刊" });
  // 截止时间内完成回避确认
  svc.confirmRecusal({ assignmentId: sunAsg.assignmentId, reason: "与候选人有供稿往来，主动回避" });
  ok(`R-孙某 在截止时间前确认回避（${sunAsg.assignmentId}）`);

  // ============ 第 3 部分：截止后迟到的回避确认被挡 ============
  advanceHours(47); // 跳到 2026-09-22 10:00，已过 09-21 18:00 回避确认截止
  section("已过回避确认截止：迟到的回避确认被挡（恢复沿用的就是原截止时间）");
  try {
    svc.confirmRecusal({ assignmentId: liAsg.assignmentId, reason: "现在才想起来要回避" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "DEADLINE_PASSED") fail(`回避确认逾期（code=${e.code}）：${e.message}`);
    else throw e;
  }

  // ============ 第 4 部分：资格结论 + 评分 ============
  section("资格结论与评分：C001 的资格在深度调查组作出，时政组直接复用");
  svc.decideQualification({ candidateId: "C001-林某", groupId: INVEST, conclusion: "qualified", basisMaterialVersion: 1, signedBy: [{ id: "O-资格官", role: "qualification-officer" }] });
  svc.decideQualification({ candidateId: "C002-赵某", groupId: INVEST, conclusion: "qualified", basisMaterialVersion: 1, signedBy: [{ id: "O-资格官", role: "qualification-officer" }] });
  svc.decideQualification({ candidateId: "C003-钱某", groupId: POLITICS, conclusion: "qualified", basisMaterialVersion: 1, signedBy: [{ id: "O-资格官", role: "qualification-officer" }] });
  const reused = svc.effectiveQualification("C001-林某", POLITICS);
  ok(`时政组引用 C001 资格结论：${reused.conclusion}，结论复用自 ${reused.reusedFromGroup === INVEST ? "深度调查组" : reused.reusedFromGroup}（评分仍只取本组）`);

  const scoreWang = svc.submitScore({ groupId: INVEST, candidateId: "C001-林某", reviewerId: "R-王某", value: 88, materialVersion: 1, requestId: "score-wang-c001" });
  svc.submitScore({ groupId: INVEST, candidateId: "C002-赵某", reviewerId: "R-周某", value: 76, materialVersion: 1 });
  svc.submitScore({ groupId: POLITICS, candidateId: "C001-林某", reviewerId: "R-李某", value: 84, materialVersion: 1 });
  svc.submitScore({ groupId: POLITICS, candidateId: "C003-钱某", reviewerId: "R-吴某", value: 91, materialVersion: 1 });
  ok(`R-王某 为 C001 提交评分 88（${scoreWang}），当时进入排名`);

  // ============ 第 5 部分：迟到利益关系 → 暂停但不删除 ============
  section("秘书处收到新材料：评委 R-王某 与候选人 C001 曾共同任职（受派之后才浮现）");
  const late = svc.reportLateInterest({ reviewerId: "R-王某", candidateId: "C001-林某", reason: "初评后收到证明：两人 2019-2021 年在同一采编部门共同任职" });
  ok(`生成迟到关系 ${late.lateInterestId}，暂停受影响评分：${late.suspendedScoreIds.join("、")}；原评分记录保留不删`);
  // 完全相同的重复请求（无编号）：识别为重复
  try {
    svc.reportLateInterest({ reviewerId: "R-王某", candidateId: "C001-林某", reason: "初评后收到证明：两人 2019-2021 年在同一采编部门共同任职" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "DUPLICATE_REQUEST") fail(`完全相同的重复请求（code=${e.code}），不产生第二份暂停记录`);
    else throw e;
  }
  const traceWang = svc.traceScore(scoreWang);
  info(`反查 ${scoreWang}：${traceWang.statusText}`);
  traceWang.reasons.forEach((r) => info(`  理由链：${r}`));

  // ============ 第 6 部分：异机构批准替补，原评委隔离 ============
  section("替补接管：同机构批准被拒，须由不同机构批准；原评委看不到替补意见");
  try {
    svc.approveSubstitute({ groupId: INVEST, candidateId: "C001-林某", replacedReviewerId: "R-王某", substituteReviewerId: "R-郑某", substituteOrg: "丙周刊", approver: { id: "A-甲社人事", org: "甲通讯社" } });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "ACCESS_DENIED") fail(`批准机构与原评委同属甲通讯社（code=${e.code}）`);
    else throw e;
  }
  const sub = svc.approveSubstitute({ groupId: INVEST, candidateId: "C001-林某", replacedReviewerId: "R-王某", substituteReviewerId: "R-郑某", substituteOrg: "丙周刊", approver: { id: "A-丁委监委", org: "丁评监委" }, requestId: "substitute-c001-invest" });
  ok(`丁评监委（异机构）批准替补 ${sub.substituteId}：R-郑某 接管，R-王某 原评分仍保留但已排除`);
  const scoreZheng = svc.submitScore({ groupId: INVEST, candidateId: "C001-林某", reviewerId: "R-郑某", value: 90, materialVersion: 1 });
  ok(`替补评委 R-郑某 重新打分 90（${scoreZheng}）`);
  try {
    svc.viewScore(scoreZheng, { id: "R-王某" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "ACCESS_DENIED") fail(`R-王某 试图查看替补意见（code=${e.code}）`);
    else throw e;
  }
  // 被替补者不得再评分
  try {
    svc.submitScore({ groupId: INVEST, candidateId: "C001-林某", reviewerId: "R-王某", value: 50, materialVersion: 1 });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "ILLEGAL_STATE") fail(`R-王某 已被替补接管，不能再提交评分`);
    else throw e;
  }

  // ============ 第 7 部分：两组独立排序、同时裁决 ============
  section("两组独立排序并同时终局裁决：资格结论可跨组复用，评分严格隔离");
  const rankInvest = svc.computeRanking(INVEST);
  const rankPolitics = svc.computeRanking(POLITICS);
  showRanking(INVEST, rankInvest);
  showRanking(POLITICS, rankPolitics);
  info(`R-王某 88 分不出现在任何序列；时政组 84 分不会串入深度调查组`);
  svc.finalizeDecision({ groupId: INVEST, signers: [{ id: "G-陈组长", role: "panel-head" }, { id: "G-韩监督", role: "supervisor" }], requestId: "final-invest" });
  svc.finalizeDecision({ groupId: POLITICS, signers: [{ id: "P-魏组长", role: "panel-head" }, { id: "P-杨监督", role: "supervisor" }] });
  ok("两个组别各自经两名不同角色（组长＋监督员）签署，独立完成终局裁决");
  svc.publishDecision({ groupId: INVEST });
  svc.publishDecision({ groupId: POLITICS });
  ok("两组决定均已公布；公布后普通评分通道关闭");

  // ============ 第 8 部分：再次恢复，按原申诉截止时间继续 ============
  advanceHours(46); // 2026-09-24 08:00，仍在 09-28 18:00 申诉截止之前
  section("申诉期内第二次崩溃恢复：申诉与截止时间继续按原记录执行");
  await svc.flush();
  svc = await ReviewService.open({ filePath: LOG_PATH, now });
  ok(`重放 ${svc.events.length} 条事件，两组“已公布”状态、暂停记录、替补关系全部恢复`);
  const appealId = svc.fileAppeal({ groupId: INVEST, candidateId: "C001-林某", target: { kind: "material", version: 1 }, reason: "申诉指向材料第 1 版：任职时间线说明被漏看，替补评分仍低估一档", requestId: "appeal-c001-v1" });
  ok(`截止前提起申诉 ${appealId}（明确指向材料版本 v1）`);
  try {
    svc.fileAppeal({ groupId: INVEST, candidateId: "C001-林某", target: { kind: "other" }, reason: "没有明确指向" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "INVALID_TARGET") fail(`不指向材料版本或程序事件的申诉（code=${e.code}）`);
    else throw e;
  }

  // ============ 第 9 部分：双人异角色重评 + 公布后追加更正 ============
  section("申诉重评：两名不同角色签署后才能录入替代评分；公布决定只能追加更正");
  const rescoreId = svc.requestRescore({ appealId });
  svc.signRescore({ rescoreId, signer: { id: "S-纪检委员", role: "ethics-officer" } });
  try {
    svc.signRescore({ rescoreId, signer: { id: "S-另一纪检", role: "ethics-officer" } });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "SIGNATURE_REQUIRED") fail(`两名签署人同为 ethics-officer（code=${e.code}）`);
    else throw e;
  }
  const second = svc.signRescore({ rescoreId, signer: { id: "S-评审组长", role: "panel-head" } });
  ok(`重评案 ${rescoreId} 集齐两名不同角色签署（完成=${second.completed}）`);
  const scoreFinal = svc.submitReplacementScore({ rescoreId, reviewerId: "R-郑某", value: 95, materialVersion: 1 });
  ok(`替代评分 ${scoreFinal}（95）录入；旧的 90 分标记为 superseded，记录与申诉链保留`);

  const corrected = svc.correctDecision({
    groupId: INVEST, appealId, reason: "申诉成立：材料第 1 版任职时间线应予采信，替补评分上调",
    signers: [{ id: "C-丁委员", role: "adjudication-chair" }, { id: "C-韩监督", role: "supervisor" }],
    requestId: "correct-invest-c001",
  });
  ok("更正以 DECISION_CORRECTED 追加：原裁决与公布记录保留，序列更新");

  const seqInvest = svc.finalSequence(INVEST);
  const seqPolitics = svc.finalSequence(POLITICS);
  console.log("");
  info(`深度调查组更正 ${seqInvest.corrections.length} 次后的最终序列：`);
  showRanking(INVEST, corrected);
  info(`时政组未受牵连，更正次数 ${seqPolitics.corrections.length}，最终序列保持：`);
  showRanking(POLITICS, seqPolitics.ranking);
  const corr = seqInvest.corrections[0];
  info(`更正链可追溯：申诉 ${corr.appealId}；原首位 ${corr.previousRanking[0].candidateId}=${corr.previousRanking[0].average} → 新首位 ${corr.newRanking[0].candidateId}=${corr.newRanking[0].average}`);

  // 申诉截止后再提申诉被挡
  advanceHours(24 * 6); // 2026-09-30，已过 09-28 18:00
  try {
    svc.fileAppeal({ groupId: POLITICS, candidateId: "C001-林某", target: { kind: "material", version: 1 }, reason: "逾期才提的申诉" });
  } catch (e) {
    if (e instanceof DomainRuleError && e.code === "DEADLINE_PASSED") fail(`申诉截止后提起（code=${e.code}），原截止时间经两次恢复仍然有效`);
    else throw e;
  }

  // ============ 第 10 部分：分数反查验收 ============
  section("验收：从一项分数反查它为何有效或被排除");
  for (const [label, id] of [["原评委评分", scoreWang], ["替补初评", scoreZheng], ["申诉终评", scoreFinal]]) {
    const t = svc.traceScore(id);
    console.log(`\n  ▸ ${label} ${id}：${t.statusText}`);
    info(`组别=${GROUP_NAME[t.groupId]} 候选人=${t.candidateId} 评委=${t.reviewerId} 分值=${t.value} 材料版本=v${t.materialVersion} 进入排名=${t.countedInRanking}`);
    if (t.assignment) info(`受派时刻冻结快照：${t.assignment.frozenSnapshot.length} 条利益关系（受派后到达的关系不回写快照）`);
    if (t.qualification) info(`资格依据：${t.qualification.conclusion}${t.qualification.reusedFromGroup ? `（复用自${GROUP_NAME[t.qualification.reusedFromGroup] ?? t.qualification.reusedFromGroup}）` : ""}`);
    t.history.forEach((h) => info(`事件 ${h.event} @ ${h.at.replace("T", " ").slice(0, 19)}：${h.explain}`));
  }

  await svc.flush();
  section(`完成：事件日志共 ${svc.events.length} 条（仅追加，保存在 ${LOG_PATH}）`);
  console.log("  所有关键规则均已演示：版本化材料、受派冻结、迟到关系暂停不删、异机构替补与意见隔离、");
  console.log("  跨组资格复用与评分隔离、申诉指向版本/事件、双人异角色签署、公布后仅追加更正、");
  console.log("  重复/同编号异内容识别，以及崩溃恢复后按原截止时间继续。\n");
}

main().catch((err) => {
  console.error("演示失败：", err);
  process.exitCode = 1;
});
