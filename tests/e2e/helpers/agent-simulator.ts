/**
 * AgentSimulator — Test utility that mimics the Pi agent calling advance_workflow.
 *
 * Abstracts away the tool invocation mechanics so tests read like a conversation:
 *
 * ```ts
 * const sim = new AgentSimulator(handler);
 * const state = await sim.startWorkflow('issue-first-development');
 * expect(state).toBeAtNode('assess-intent');
 *
 * const next = await sim.advance({ project_name: 'pi-daemon', requires_edits: true });
 * expect(next).toBeAtNode('implement-code');
 * ```
 */

import type { AdvanceWorkflowHandler, AdvanceWorkflowOutput } from '../../../src/extension/advance-workflow-tool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed data extracted from a markdown agent response. */
export interface ParsedAgentResponse {
  workflowName: string;
  instanceId: string;
  status: string;
  currentNodeId?: string;
  nodeType?: string;
  instruction?: string;
  requiredFields?: string[];
  systemActionResults?: { nodeId: string; success: boolean }[];
  isTerminal: boolean;
  terminalStatus?: string;
  terminalMessage?: string;
  historyNodes?: string[];
}

/** State returned by the simulator after each tool call. */
export interface AgentSimulatorState {
  instanceId: string;
  currentNodeId: string | null;
  status: string;
  rawResponse: string;
  parsed: ParsedAgentResponse;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// AgentSimulator
// ---------------------------------------------------------------------------

export class AgentSimulator {
  private readonly handler: AdvanceWorkflowHandler;
  private currentInstanceId: string | null = null;
  private currentNodeId: string | null = null;
  private messageCount = 0;

  constructor(handler: AdvanceWorkflowHandler) {
    this.handler = handler;
  }

  /**
   * Call the advance_workflow tool with raw parameters.
   * Returns the formatted markdown response.
   */
  async call(params: Record<string, unknown>): Promise<AdvanceWorkflowOutput> {
    return this.handler.handle(params as Parameters<AdvanceWorkflowHandler['handle']>[0]);
  }

  /**
   * Start a new workflow instance.
   */
  async startWorkflow(name: string, initialPayload?: Record<string, unknown>): Promise<AgentSimulatorState> {
    const result = await this.handler.handle({
      action: 'start',
      workflow_name: name,
      node_payload: initialPayload,
      confirm: true,
    });

    const parsed = this.parseResponse(result.text);

    this.currentInstanceId = parsed.instanceId;
    this.currentNodeId = parsed.currentNodeId ?? null;

    if (!result.isError && parsed.currentNodeId) {
      this.messageCount++;
    }

    return {
      instanceId: parsed.instanceId,
      currentNodeId: parsed.currentNodeId ?? null,
      status: parsed.status,
      rawResponse: result.text,
      parsed,
      isError: result.isError ?? false,
    };
  }

  /**
   * Advance the current workflow with a payload for the current node.
   */
  async advance(nodePayload: Record<string, unknown>): Promise<AgentSimulatorState> {
    if (!this.currentInstanceId) {
      throw new Error('No active workflow instance. Call startWorkflow first.');
    }
    if (!this.currentNodeId) {
      throw new Error(
        'No current node ID. The workflow may have errored — use advanceWithNodeId() or check the previous response.',
      );
    }

    const result = await this.handler.handle({
      action: 'advance',
      instance_id: this.currentInstanceId,
      current_node_id: this.currentNodeId,
      node_payload: nodePayload,
    });

    const parsed = this.parseResponse(result.text);

    // Only update current node on success — preserve it on error so retry works
    if (!result.isError && parsed.currentNodeId) {
      this.currentNodeId = parsed.currentNodeId;
    } else if (!result.isError && parsed.isTerminal) {
      this.currentNodeId = null;
    }

    if (!result.isError) {
      this.messageCount++;
    }

    return {
      instanceId: this.currentInstanceId,
      currentNodeId: this.currentNodeId,
      status: parsed.status,
      rawResponse: result.text,
      parsed,
      isError: result.isError ?? false,
    };
  }

  /**
   * Advance with an explicit node_id (for error recovery testing).
   */
  async advanceWithNodeId(nodeId: string, nodePayload: Record<string, unknown>): Promise<AgentSimulatorState> {
    if (!this.currentInstanceId) {
      throw new Error('No active workflow instance. Call startWorkflow first.');
    }

    const result = await this.handler.handle({
      action: 'advance',
      instance_id: this.currentInstanceId,
      current_node_id: nodeId,
      node_payload: nodePayload,
    });

    const parsed = this.parseResponse(result.text);

    // Only update current node if not an error
    if (!result.isError && parsed.currentNodeId) {
      this.currentNodeId = parsed.currentNodeId;
    }

    if (!result.isError) {
      this.messageCount++;
    }

    return {
      instanceId: this.currentInstanceId,
      currentNodeId: parsed.currentNodeId ?? this.currentNodeId,
      status: parsed.status,
      rawResponse: result.text,
      parsed,
      isError: result.isError ?? false,
    };
  }

  /**
   * Get the status of the current instance.
   */
  async getStatus(): Promise<AgentSimulatorState> {
    if (!this.currentInstanceId) {
      throw new Error('No active workflow instance.');
    }

    const result = await this.handler.handle({
      action: 'status',
      instance_id: this.currentInstanceId,
    });

    const parsed = this.parseResponse(result.text);

    return {
      instanceId: this.currentInstanceId,
      currentNodeId: parsed.currentNodeId ?? this.currentNodeId,
      status: parsed.status,
      rawResponse: result.text,
      parsed,
      isError: result.isError ?? false,
    };
  }

  /**
   * Get the number of non-error messages received by the agent.
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Get the current instance ID.
   */
  getInstanceId(): string | null {
    return this.currentInstanceId;
  }

  /**
   * Get the current node ID.
   */
  getCurrentNodeId(): string | null {
    return this.currentNodeId;
  }

  /**
   * Parse a markdown response from the tool into structured data.
   */
  parseResponse(markdown: string): ParsedAgentResponse {
    const result: ParsedAgentResponse = {
      workflowName: '',
      instanceId: '',
      status: '',
      isTerminal: false,
    };

    // Extract workflow name from header line formats:
    // > **WORKFLOW:** name  OR  > WORKFLOW: name (instance id)
    const workflowMatch = markdown.match(/\*\*WORKFLOW:\*\*\s+(\S+)/) ?? markdown.match(/> WORKFLOW:\s+(\S+)/);
    if (workflowMatch) {
      result.workflowName = workflowMatch[1]!;
    }

    // Extract instance ID from header formats:
    // > **INSTANCE:** id  OR  > WORKFLOW: name (instance id)
    const instanceMatch = markdown.match(/\*\*INSTANCE:\*\*\s+(\S+)/) ?? markdown.match(/\(instance\s+([^)]+)\)/);
    if (instanceMatch) {
      result.instanceId = instanceMatch[1]!;
    }

    // Extract status from various formats:
    // > **STATUS:** ...  OR  > STATUS: ...
    const statusMatch = markdown.match(/\*\*STATUS:\*\*\s+(.+)/) ?? markdown.match(/> STATUS:\s+(.+)/);
    if (statusMatch) {
      result.status = statusMatch[1]!.trim();
    }

    // Extract current node from:
    // ## Current Node: `nodeId`  OR  > CURRENT NODE: nodeId
    const nodeMatch = markdown.match(/Current Node:\s*`([^`]+)`/) ?? markdown.match(/> CURRENT NODE:\s+(\S+)/);
    if (nodeMatch) {
      result.currentNodeId = nodeMatch[1]!;
    }

    // Extract node type
    const typeMatch = markdown.match(/\*\*Type:\*\*\s+(\S+)/) ?? markdown.match(/> NODE TYPE:\s+(\S+)/);
    if (typeMatch) {
      result.nodeType = typeMatch[1]!;
    }

    // Extract instruction from:
    // ### Instructions\n<text>  OR  > INSTRUCTIONS: <text>
    const instructionMatch =
      markdown.match(/### Instructions\n([\s\S]*?)(?=\n###|\n---|\n$)/) ?? markdown.match(/> INSTRUCTIONS:\s+(.+)/);
    if (instructionMatch) {
      result.instruction = instructionMatch[1]!.trim();
    }

    // Extract required fields from JSON in Required Action section
    const schemaMatch = markdown.match(/"node_payload":\s*\{([^}]+)\}/);
    if (schemaMatch) {
      const fields = schemaMatch[1]!.match(/"(\w+)":/g);
      if (fields) {
        result.requiredFields = fields.map((f) => f.replace(/"/g, '').replace(':', ''));
      }
    }

    // Extract system action results
    const sysActionRegex = /[✅❌]\s*`([^`]+)`:\s*(exit code (\d+)|timed out)/g;
    const systemResults: { nodeId: string; success: boolean }[] = [];
    let sysMatch;
    while ((sysMatch = sysActionRegex.exec(markdown)) !== null) {
      systemResults.push({
        nodeId: sysMatch[1]!,
        success: sysMatch[2]!.startsWith('exit code 0'),
      });
    }

    // Also check agent-message-formatter format: node: exit N
    const agentSysRegex = /(\S+):\s*exit\s+(\d+)/g;
    let agentSysMatch;
    while ((agentSysMatch = agentSysRegex.exec(markdown)) !== null) {
      const nodeId = agentSysMatch[1]!;
      const exitCode = parseInt(agentSysMatch[2]!, 10);
      // Avoid duplicates
      if (!systemResults.some((r) => r.nodeId === nodeId)) {
        systemResults.push({ nodeId, success: exitCode === 0 });
      }
    }

    if (systemResults.length > 0) {
      result.systemActionResults = systemResults;
    }

    // Extract history nodes (do this early — we need it for terminal status detection)
    const historyRegex = /\d+\.\s*[✅⏳]\s*(\S+)\s*\(([^)]+)\)/g;
    const historyNodes: string[] = [];
    let histMatch;
    while ((histMatch = historyRegex.exec(markdown)) !== null) {
      historyNodes.push(histMatch[1]!);
      // If this is a terminal node, mark as terminal
      if (histMatch[2] === 'terminal') {
        result.isTerminal = true;
      }
    }
    if (historyNodes.length > 0) {
      result.historyNodes = historyNodes;
    }

    // Check for terminal state from multiple indicators
    if (
      markdown.includes('Workflow completed') ||
      markdown.includes('completed with status') ||
      markdown.includes('TERMINAL STATUS')
    ) {
      result.isTerminal = true;
    }

    // Extract terminal status from explicit markers
    const terminalMatch =
      markdown.match(/TERMINAL STATUS:\s*(\S+)/) ?? markdown.match(/completed with status:\s*(\S+)/);
    if (terminalMatch) {
      result.terminalStatus = terminalMatch[1]!;
    }

    // If no explicit terminal status but we have history, infer from terminal node
    if (result.isTerminal && !result.terminalStatus && historyNodes.length > 0) {
      const lastNode = historyNodes[historyNodes.length - 1]!;
      // Detect failure from terminal node name or summary message
      if (lastNode.includes('fail') || lastNode.includes('error') || lastNode.includes('timeout')) {
        result.terminalStatus = 'failure';
      } else {
        result.terminalStatus = 'success';
      }
    }

    // Also detect success from specific patterns
    if (result.isTerminal && !result.terminalStatus) {
      if (markdown.includes('Workflow completed successfully')) {
        result.terminalStatus = 'success';
      }
    }

    // Extract terminal message from Summary section
    const summaryMatch = markdown.match(/## Summary\n([\s\S]*?)(?=\n###|\n---|\n$)/);
    if (summaryMatch) {
      result.terminalMessage = summaryMatch[1]!.trim();
    }

    // Also check for MESSAGE: format
    const termMsgMatch = markdown.match(/> MESSAGE:\s+(.+)/);
    if (termMsgMatch) {
      result.terminalMessage = termMsgMatch[1]!.trim();
    }

    return result;
  }
}
