import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
export default function (pi: any) {
  const faux = createFauxCore({ provider: "workflow-private", models: [{ id: "private" }] });
  faux.setResponses([fauxAssistantMessage("PRIVATE_WORKFLOW_REPLY")]);
  pi.registerProvider("workflow-private", { api: faux.api, apiKey: "synthetic-private", models: faux.models, streamSimple: faux.streamSimple });
}
