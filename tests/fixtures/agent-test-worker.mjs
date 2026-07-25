#!/usr/bin/env node

function send(
  response,
) {
  if (!process.send) {
    process.exitCode = 1;
    return;
  }

  process.send(
    response,
    () => {
      if (process.connected) {
        process.disconnect();
      }
    },
  );
}

process.on(
  "message",
  (
    request,
  ) => {
    if (
      request.task ===
      "__HANG__"
    ) {
      setInterval(
        () => {},
        1000,
      );

      return;
    }

    const model =
      request.agent.model ??
      request.config
        .defaultModel;

    if (
      request.task ===
      "__FAIL__"
    ) {
      send({
        type:
          "result",
        requestId:
          request.requestId,
        success:
          false,
        error:
          "Intentional test failure",
        model,
        workerPid:
          process.pid,
      });

      return;
    }

    send({
      type:
        "result",
      requestId:
        request.requestId,
      success:
        true,
      output:
        JSON.stringify({
          agentName:
            request.agent.name,
          description:
            request.agent.description,
          systemPrompt:
            request.agent
              .systemPrompt,
          model,
          task:
            request.task,
          context:
            request.context ??
            null,
        }),
      model,
      workerPid:
        process.pid,
    });
  },
);
