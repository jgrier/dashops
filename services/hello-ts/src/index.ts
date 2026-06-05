import * as restate from "@restatedev/restate-sdk";

export const hello = restate.service({
  name: "HelloTs",
  handlers: {
    greet: async (_ctx: restate.Context, name: string) => {
      return `Hello, ${name}! (from TypeScript)`;
    },
  },
});

const port = parseInt(process.env.PORT ?? "9081", 10);
restate.serve({ services: [hello], port });
console.log(`HelloTs listening on :${port}`);
