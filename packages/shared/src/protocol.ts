// WebSocket message protocol — shared between server, app, and relay
//
// Client → Server:
//   prompt, command, set_cwd, abort, resume_session,
//   respond_question, respond_permission
//
// Server → Client:
//   stream_delta, assistant_text, thinking, tool_use, tool_result,
//   result, session_status_changed, permission_request,
//   account_changed, cron_execution_request, query_summary

export {}
