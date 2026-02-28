# Corrective RAG — YAML Configuration Example

To enable the corrective RAG graph, add a `kb_search` action to `routing-config.yaml`
under `actions:`. This replaces the single-shot KB context injection with an iterative
retrieve → grade → reformulate loop.

## Option A: Replace the `chat` action's execution

Change the `chat` action to use the graph instead of a plain reply:

```yaml
  chat:
    enabled: true
    description: |
      Respond conversationally using knowledge base context when relevant.
      Put your full response in the 'response' field.
    routing_hint: >
      The user is asking a question, having a conversation, or their message doesn't
      map to any other action. Use the knowledge bases to find relevant context and
      answer thoroughly.
    parameters:
      response:
        type: string
        description: Your conversational response to the user
        required: true
      query:
        type: string
        description: The user's question or topic to search knowledge bases for
        required: true
    execution:
      type: langgraph
      graph: corrective_rag
      graph_config:
        scopes:
          - chat
          - all
        max_retrievals: 3
        max_chunks: 8
        min_score: 0.3
        max_answer_tokens: 1024
      reply_error: "⚠️ I had trouble searching the knowledge bases: {{error}}"
```

## Option B: Add a dedicated `kb_search` action alongside `chat`

This keeps `chat` as a lightweight conversational reply and adds a separate action
for deep KB-powered answers:

```yaml
  kb_search:
    enabled: true
    description: |
      Search the knowledge bases to answer a question using stored documentation,
      design docs, or other indexed content. Use this when the user asks a factual
      question that might be answered by the knowledge bases.
    routing_hint: >
      The user is asking a question that could be answered by searching the knowledge
      bases — e.g. "how does X work?", "what's our policy on Y?", "where is the docs
      for Z?". Prefer this over chat when the question is about something that might
      be documented.
    parameters:
      query:
        type: string
        description: The search query / question to answer from knowledge bases
        required: true
    execution:
      type: langgraph
      graph: corrective_rag
      graph_config:
        scopes:
          - chat
          - all
        max_retrievals: 3
        max_chunks: 8
        min_score: 0.25
        max_answer_tokens: 1024
      reply_error: "⚠️ Knowledge base search failed: {{error}}"
```

## Configuration Options

| Field | Default | Description |
|-------|---------|-------------|
| `graph_config.scopes` | `["chat", "all"]` | Which KB scopes to search |
| `graph_config.max_retrievals` | `3` | Max retrieve→grade→reformulate loops |
| `graph_config.max_chunks` | `8` | Chunks per retrieval pass |
| `graph_config.min_score` | `0.3` | Minimum similarity score |
| `graph_config.model` | Server's configured model | LLM for grading + answering |
| `graph_config.max_answer_tokens` | `1024` | Max tokens for the final answer |
