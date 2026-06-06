import { convertToPostgresPlaceholders } from "./DbUtils";

describe("convertToPostgresPlaceholders", () => {
  it("should convert single ?", () => {
    expect(convertToPostgresPlaceholders("SELECT * FROM t WHERE id = ?")).toBe(
      "SELECT * FROM t WHERE id = $1",
    );
  });

  it("should convert multiple ? to $1, $2, ...", () => {
    expect(
      convertToPostgresPlaceholders("INSERT INTO t (a,b,c) VALUES (?,?,?)"),
    ).toBe("INSERT INTO t (a,b,c) VALUES ($1,$2,$3)");
  });

  it("should return SQL unchanged when no ? present", () => {
    expect(convertToPostgresPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("should handle empty string", () => {
    expect(convertToPostgresPlaceholders("")).toBe("");
  });
});
