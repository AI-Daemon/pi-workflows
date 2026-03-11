# Expression Reference

> **Who is this for?** Workflow authors who need to write transition condition expressions.
>
> **What you'll learn:** All operators, transforms, context variables, and common patterns for jexl expressions.

## Operators

### Comparison Operators

| Operator | Description      | Example               | Result                |
| -------- | ---------------- | --------------------- | --------------------- |
| `==`     | Equal            | `payload.x == 5`      | `true` if x is 5      |
| `!=`     | Not equal        | `payload.x != 0`      | `true` if x is not 0  |
| `>`      | Greater than     | `payload.count > 10`  | `true` if count > 10  |
| `>=`     | Greater or equal | `payload.count >= 3`  | `true` if count ≥ 3   |
| `<`      | Less than        | `payload.count < 100` | `true` if count < 100 |
| `<=`     | Less or equal    | `payload.count <= 5`  | `true` if count ≤ 5   |

### Logical Operators

| Operator | Description | Example                                    |
| -------- | ----------- | ------------------------------------------ |
| `&&`     | Logical AND | `payload.a == true && payload.b > 0`       |
| `\|\|`   | Logical OR  | `payload.a == true \|\| payload.b == true` |
| `!`      | Logical NOT | `!(payload.done)`                          |

### Membership Operators

| Operator | Description      | Example                    |
| -------- | ---------------- | -------------------------- |
| `in`     | Array membership | `'admin' in payload.roles` |

### Ternary Operator

```
payload.count > 5 ? true : false
```

## Transforms

Transforms are piped with `|`:

| Transform | Input           | Output             | Example                         |
| --------- | --------------- | ------------------ | ------------------------------- |
| `lower`   | any             | string (lowercase) | `payload.name\|lower == 'test'` |
| `upper`   | any             | string (uppercase) | `payload.name\|upper == 'TEST'` |
| `length`  | string or array | number             | `payload.items\|length > 0`     |
| `trim`    | any             | string (trimmed)   | `payload.input\|trim != ''`     |

## Context Variables

| Variable                  | Available After | Description                         |
| ------------------------- | --------------- | ----------------------------------- |
| `payload.*`               | Always          | Current workflow payload            |
| `action_result.exit_code` | `system_action` | Process exit code (int)             |
| `action_result.stdout`    | `system_action` | Standard output (string)            |
| `action_result.stderr`    | `system_action` | Standard error (string)             |
| `action_result.data`      | `system_action` | Parsed JSON from stdout (if valid)  |
| `action_result.timed_out` | `system_action` | Whether command timed out (boolean) |
| `metadata.*`              | Always          | Workflow-level metadata             |
| `$metadata.visits.*`      | v2.0 only       | Per-node visit counts               |
| `$metadata.state_hashes`  | v2.0 only       | SHA-256 hashes from stall detection |
| `$metadata.instance_id`   | v2.0 only       | Instance UUID                       |

## Special Conditions

| Condition   | Behavior                                        |
| ----------- | ----------------------------------------------- |
| `'true'`    | Always evaluates to `true` — catch-all fallback |
| `'default'` | Same as `'true'` — catch-all fallback           |

## Null/Undefined Handling

- Accessing a missing payload key returns `undefined`
- `undefined` and `null` expression results evaluate to `false`
- This means `payload.missing_key == true` evaluates to `false` (not an error)

## Type Coercion

jexl does **not** perform implicit type coercion:

- `payload.count == '5'` is `false` if `count` is the number `5`
- Use explicit comparisons: `payload.count == 5` for numbers, `payload.name == 'test'` for strings

## Array Operations

```
# Check if array contains a value
'admin' in payload.roles

# Check array length
payload.items|length > 0
payload.items|length == 3
```

## Expression Examples

### Basic routing

```
payload.requires_edits == true
payload.requires_edits == false
```

### Exit code checking

```
action_result.exit_code == 0
action_result.exit_code != 0
```

### Combined conditions

```
action_result.exit_code != 0 && $metadata.visits.run_tests >= 3
payload.approved == true && payload.reviewer == 'lead'
```

### String matching

```
payload.issue_type == 'bug'
payload.name|lower == 'test'
payload.output|trim != ''
```

### Cycle-aware transitions (v2.0)

```
$metadata.visits.run_tests >= 3
action_result.exit_code != 0 && $metadata.visits.run_tests < 3
```

### Non-empty stdout check

```
action_result.stdout != ''
action_result.stdout|trim|length > 0
```

## Edge Cases

| Expression            | Context                    | Result                     |
| --------------------- | -------------------------- | -------------------------- |
| `payload.x == 5`      | `{ payload: {} }`          | `false` (x is undefined)   |
| `payload.x > 3`       | `{ payload: { x: null } }` | `false`                    |
| `payload.x == null`   | `{ payload: {} }`          | `true` (undefined == null) |
| `payload.arr\|length` | `{ payload: { arr: [] } }` | `0`                        |
| `payload.str\|length` | `{ payload: { str: '' } }` | `0`                        |
| `payload.num\|length` | `{ payload: { num: 42 } }` | `0` (not string/array)     |

## Limits

- Maximum expression length: **500 characters**
- Evaluation timeout: **100ms** (configurable)
- Must evaluate to **boolean** — non-boolean results produce error `E-003`

---

_See also: [Workflow Authoring Guide](./workflow-authoring-guide.md) · [API Reference](./api-reference.md)_
