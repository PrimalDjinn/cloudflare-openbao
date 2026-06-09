import { Container, type StopParams } from "@cloudflare/containers";

export class BaoContainer extends Container {
  defaultPort = 8200; // Port the container is listening on
  sleepAfter = "10m"; // Stop the instance if requests not sent for 10 minutes

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    if(!env.BAO_STATIC_SEAL_KEY) {
      throw new Error("You need to set a BAO_STATIC_SEAL_KEY environment variable")
    }

    // Construct the connection URL required by the OpenBao D1 storage driver:
    // Format: https://<AccountID>:<APIToken>@<DatabaseID>
    if(!env.BAO_D1_CONNECTION_URL) {
      throw new Error("You need to set a BAO_D1_CONNECTION_URL environment variable")
    }

    super(ctx, env);
    this.envVars = {
      BAO_D1_CONNECTION_URL: env.BAO_D1_CONNECTION_URL,
      BAO_STATIC_SEAL_KEY: env.BAO_STATIC_SEAL_KEY, // The driver uses this for static unsealing
      BAO_ADDR: "http://0.0.0.0:8200",
      SKIP_SETCAP: "true",
    };
  }

  override onStart() {
    console.log("OpenBao container successfully started");
    super.onStart();
  }

  override onStop(params: StopParams) {
    console.log("OpenBao container successfully shut down", params);
    super.onStop(params);
  }

  override onError(error: unknown) {
    console.log("OpenBao container error:", error);
    super.onError(error);
  }
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, _: ExecutionContext) {
    const container = env.BAO_CONTAINER.getByName("BAO_CONTAINER", {
      routingMode: "primary-only",
    });
    return container.fetch(request);
  },
};
