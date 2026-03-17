export type JsonMap = Record<string, any>;

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  suggestions?: string[];
  refs?: Array<{ type?: string; path?: string; line?: number; label?: string }>;
  attachments?: Array<{
    id?: string;
    kind?: string;
    name?: string;
    originalName?: string;
    path?: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
};

export type ChatThread = {
  id: string;
  title: string;
  changeSessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type ModuleDefinition = {
  id: string;
  label: string;
  description: string;
};

export type InspectorState = {
  selectedPath: string;
  fileContent: string;
  diffContent: string;
  fileStatus: string;
  diffStatus: string;
  reviewNote: string;
};
