package dev.dashops.gateway

import dev.restate.sdk.annotation.Handler
import dev.restate.sdk.annotation.Service
import dev.restate.sdk.endpoint.Endpoint
import dev.restate.sdk.http.vertx.RestateHttpServer
import dev.restate.sdk.kotlin.Context

@Service
class Hello {
    @Handler
    suspend fun greet(ctx: Context, name: String): String =
        "Hello, $name! (from Kotlin)"
}

fun main() {
    RestateHttpServer.listen(Endpoint.bind(Hello()))
}
