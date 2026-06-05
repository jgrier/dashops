plugins {
    kotlin("jvm") version "2.2.10"
    id("com.google.devtools.ksp") version "2.2.10-2.0.2"
    application
}

group = "dev.dashops"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    ksp("dev.restate:sdk-api-kotlin-gen:2.4.1")
    implementation("dev.restate:sdk-kotlin-http:2.4.1")
}

application {
    mainClass.set("dev.dashops.gateway.HelloKt")
}

kotlin {
    jvmToolchain(21)
}
