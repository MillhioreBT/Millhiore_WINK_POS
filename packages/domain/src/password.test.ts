import { describe, expect, test } from "bun:test"
import { passwordProblem, temporaryPassword } from "./password"
import { pinProblem } from "./pin"

describe("contraseñas", () => {
  test("acepta una razonable", () => {
    expect(passwordProblem("arepa-con-queso-7")).toBeNull()
    expect(passwordProblem("Gato.Azul.2026", { username: "pedro" })).toBeNull()
  })

  test("rechaza cortas, repetidas y comunes", () => {
    expect(passwordProblem("corta1")).toMatch(/al menos 8/)
    expect(passwordProblem("aaaaaaaaaa")).toMatch(/variada/)
    expect(passwordProblem("12345678")).toMatch(/común/)
    expect(passwordProblem("Contraseña1")).toMatch(/común/)
    expect(passwordProblem("34567890")).toMatch(/común/)
  })

  test("no puede contener el usuario, el nombre ni el negocio", () => {
    expect(passwordProblem("pedro2026!", { username: "pedro" })).toMatch(/usuario/)
    expect(passwordProblem("xx-María-xx", { name: "Maria" })).toMatch(/nombre/)
    expect(passwordProblem("LaEsquina2026", { businessName: "La Esquina" })).toMatch(/negocio/)
  })

  test("las temporales tienen formato fácil de dictar y cumplen las reglas", () => {
    const t = temporaryPassword()
    expect(t).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    expect(t).not.toMatch(/[01ilo]/)
    expect(passwordProblem(t)).toBeNull()
  })
})

describe("pinProblem", () => {
  test("acepta PIN de 4 a 6 dígitos que no sean triviales", () => {
    for (const pin of ["4821", "73920", "804915", "1357", "2580"]) {
      expect(pinProblem(pin)).toBeNull()
    }
  })

  test("rechaza lo que cualquiera prueba primero", () => {
    expect(pinProblem("0000")).toMatch(/repita/)
    expect(pinProblem("777777")).toMatch(/repita/)
    expect(pinProblem("1234")).toMatch(/secuencia/)
    expect(pinProblem("4321")).toMatch(/secuencia/)
    expect(pinProblem("567890".slice(0, 4))).toMatch(/secuencia/)
  })

  test("solo números y entre 4 y 6", () => {
    expect(pinProblem("12a4")).toMatch(/números/)
    expect(pinProblem("")).toMatch(/números/)
    expect(pinProblem("147")).toMatch(/entre 4 y 6/)
    expect(pinProblem("1478952")).toMatch(/entre 4 y 6/)
  })
})
