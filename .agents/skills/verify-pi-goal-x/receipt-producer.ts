import { Type } from "@earendil-works/pi-ai";

export default function(pi) {
 let task;
 pi.registerTool({
  name: "agent", label: "Receipt replay agent", description: "Verification scaffold. Replay one pstack launch receipt; no child process runs.",
  parameters: Type.Object({}),
  async execute() {
   task = { agentId: "verify-receipt-task", status: "running" };
   return { content: [{ type: "text", text: "Receipt replay only. End this turn; wait for the explicit verification report command." }], details: task };
  },
 });
 pi.registerCommand("verify-report", {
  description: "Receipt scaffold only. Emit a matching pstack terminal notification.",
  handler: async (args) => {
   if (!task || !["completed", "failed", "stopped"].includes(args.trim())) throw new Error("Launch the receipt agent and specify completed, failed or stopped");
   pi.sendMessage({ customType: "pstack-agent", content: `Verification receipt replay: ${args.trim()}. The producer did not run a child. Follow the goal's reporting instructions.`, display: true, details: { agentId: task.agentId, status: args.trim(), exitCode: args.trim() === "completed" ? 0 : 1 } }, { triggerTurn: true });
  },
 });
}
