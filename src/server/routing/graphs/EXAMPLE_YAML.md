# Corrective RAG — LangGraph Execution Type

The `langgraph` execution type runs a LangGraph state machine as an action handler.
Currently supports the `corrective_rag` graph, which iteratively retrieves from
knowledge bases, grades relevance, reformulates queries, and synthesizes answers.

See `routing-config.yaml` for the active `kb_search` action definition.

## Graph: `corrective_rag`

```
retrieve → grade_relevance → ─┬─ sufficient ──→ synthesize → END
                               ├─ empty ───────→ synthesize → END
                               └─ insufficient ─→ reformulate_query → retrieve (loop)
                                    (capped at max_retrievals)
```

## Configuration Options (`graph_config`)

| Field | Default | Description |
|-------|---------|-------------|
| `scopes` | `["chat", "all"]` | Which KB scopes to search |
| `max_retrievals` | `3` | Max retrieve→grade→reformulate loops |
| `max_chunks` | `8` | Chunks per retrieval pass |
| `min_score` | `0.3` | Minimum similarity score |
| `model` | Server's configured model | LLM for grading + answering |
| `max_answer_tokens` | `1024` | Max tokens for the final answer |
| `show_trace` | `true` | Append a trace summary footer to the Slack reply |
| `timeout_ms` | `Infinity` | Total timeout for the graph execution |

## Adding New Graphs

1. Create `src/server/routing/graphs/myGraph.ts` with a `runMyGraph()` function
2. Add a `case "my_graph"` to the switch in `graphExecutor.ts → runGraph()`
3. Use `execution.graph: my_graph` in the YAML action definition
