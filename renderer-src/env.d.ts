export {};

type LooseRecord = Record<string, any>;

declare global {
  interface Window {
    gosAgent: {
      bootstrap: (payload?: LooseRecord) => Promise<LooseRecord>;
      bootstrapLite: (payload?: LooseRecord) => Promise<LooseRecord>;
      getMeta: () => Promise<LooseRecord>;
      getSettings: () => Promise<LooseRecord>;
      setSecret: (name: string, value: string) => Promise<LooseRecord>;
      getSecret: (name: string) => Promise<LooseRecord>;
      setWorkspace: (workspaceRoot: string) => Promise<LooseRecord>;
      setLab: (payload?: LooseRecord) => Promise<LooseRecord>;
      updateSettings: (payload: LooseRecord) => Promise<LooseRecord>;
      reportRendererError: (payload?: LooseRecord) => Promise<LooseRecord>;
      pickWorkspace: () => Promise<LooseRecord>;
      cancel: (payload?: LooseRecord) => Promise<LooseRecord>;
      chatMessage: (text: string, workspace?: string, options?: LooseRecord) => Promise<LooseRecord>;
      pickChatAttachments: (payload?: LooseRecord) => Promise<LooseRecord>;
      listSkills: () => Promise<LooseRecord[] | LooseRecord>;
      runSkill: (payload?: LooseRecord) => Promise<LooseRecord>;
      listAutomations: () => Promise<LooseRecord[] | LooseRecord>;
      listTools: () => Promise<LooseRecord>;
      listIntegrations: (payload?: LooseRecord) => Promise<LooseRecord>;
      installIntegration: (payload?: LooseRecord) => Promise<LooseRecord>;
      getAiStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      importAiModels: (payload?: LooseRecord) => Promise<LooseRecord>;
      getReviewSnapshot: (payload?: LooseRecord) => Promise<LooseRecord>;
      readReviewFile: (payload: LooseRecord) => Promise<LooseRecord>;
      getReviewDiff: (payload: LooseRecord) => Promise<LooseRecord>;
      saveReviewFile: (payload: LooseRecord) => Promise<LooseRecord>;
      setReviewDecision: (payload: LooseRecord) => Promise<LooseRecord>;
      openInVsCode: (payload: LooseRecord) => Promise<LooseRecord>;
      openLocation: (payload: LooseRecord) => Promise<LooseRecord>;
      getTuningStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      startOllama: (payload?: LooseRecord) => Promise<LooseRecord>;
      stopOllama: (payload?: LooseRecord) => Promise<LooseRecord>;
      getWorkspaceVsCodeStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      bootstrapWorkspaceVsCode: (payload?: LooseRecord) => Promise<LooseRecord>;
      getModelFoundryStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      seedModelFoundryCandidate: (payload?: LooseRecord) => Promise<LooseRecord>;
      getLearningChanges: (payload?: LooseRecord) => Promise<LooseRecord>;
      getLearningStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      exportLearningChanges: (payload?: LooseRecord) => Promise<LooseRecord>;
      learning: {
        capture: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      fetchApprovedDoc: (payload?: LooseRecord) => Promise<LooseRecord>;
      prepareTrainingHandoff: (payload?: LooseRecord) => Promise<LooseRecord>;
      exportLocalTraining: (payload?: LooseRecord) => Promise<LooseRecord>;
      listLabs: (payload?: LooseRecord) => Promise<LooseRecord>;
      createLab: (payload?: LooseRecord) => Promise<LooseRecord>;
      resetLab: (payload?: LooseRecord) => Promise<LooseRecord>;
      destroyLab: (payload?: LooseRecord) => Promise<LooseRecord>;
      runLabRecipe: (payload?: LooseRecord) => Promise<LooseRecord>;
      createTask: (payload?: LooseRecord) => Promise<LooseRecord>;
      queueFollowupRecipe: (payload?: LooseRecord) => Promise<LooseRecord>;
      listPromotions: (payload?: LooseRecord) => Promise<LooseRecord>;
      createCandidate: (payload?: LooseRecord) => Promise<LooseRecord>;
      promoteCandidate: (payload?: LooseRecord) => Promise<LooseRecord>;
      rollbackPromotion: (payload?: LooseRecord) => Promise<LooseRecord>;
      listBenchmarks: (payload?: LooseRecord) => Promise<LooseRecord>;
      runBenchmark: (payload?: LooseRecord) => Promise<LooseRecord>;
      getMonitorStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
      getMonitorEvents: (payload?: LooseRecord) => Promise<LooseRecord>;
      recordOperatorFeedback: (payload?: LooseRecord) => Promise<LooseRecord>;
      runMonitorAcceptance: (payload?: LooseRecord) => Promise<LooseRecord>;
      setMonitorSafeMode: (payload?: LooseRecord) => Promise<LooseRecord>;
      exportMonitorDebugBundle: (payload?: LooseRecord) => Promise<LooseRecord>;
      listBackups: (payload?: LooseRecord) => Promise<LooseRecord[] | LooseRecord>;
      rollbackUpdates: (payload?: LooseRecord) => Promise<LooseRecord>;
      promotions: {
        list: (payload?: LooseRecord) => Promise<LooseRecord>;
        createCandidate: (payload?: LooseRecord) => Promise<LooseRecord>;
        promote: (payload?: LooseRecord) => Promise<LooseRecord>;
        rollback: (payload?: LooseRecord) => Promise<LooseRecord>;
        history: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      workspace: {
        vscodeStatus: (payload?: LooseRecord) => Promise<LooseRecord>;
        vscodeBootstrap: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      integrations: {
        list: (payload?: LooseRecord) => Promise<LooseRecord>;
        install: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      foundry: {
        status: (payload?: LooseRecord) => Promise<LooseRecord>;
        seed: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      monitor: {
        status: (payload?: LooseRecord) => Promise<LooseRecord>;
        events: (payload?: LooseRecord) => Promise<LooseRecord>;
        recordOperatorFeedback: (payload?: LooseRecord) => Promise<LooseRecord>;
        runAcceptance: (payload?: LooseRecord) => Promise<LooseRecord>;
        setSafeMode: (payload?: LooseRecord) => Promise<LooseRecord>;
        debugBundle: (payload?: LooseRecord) => Promise<LooseRecord>;
      };
      updates: {
        rollback: (payload?: LooseRecord) => Promise<LooseRecord>;
        backups: (payload?: LooseRecord) => Promise<LooseRecord[] | LooseRecord>;
      };
      onRunEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onSchedulerEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onUpdateEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onTuningImportEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onLearningEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onLabEvent: (handler: (payload: LooseRecord) => void) => () => void;
      onBenchmarkEvent: (handler: (payload: LooseRecord) => void) => () => void;
    };
  }
}
