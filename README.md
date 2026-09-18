# HabboPackets

List of Habbo packets,
imported from [**G-Rust**](https://github.com/G-Realm/G-Rust)

## Layout notation

| Token | Meaning |
|-------|---------|
| `s` / `S`  | short / long string |
| `c` / `h`  | byte / short |
| `i` / `d`  | int / long |
| `b`        | bool |
| `f` / `g`  | float / double |
| `i[ … ]`   | the int before the brackets = number of iterations, then the group inside repeated |
| `#N[ … ]`  | fixed array : exactly N times, with no counter |
| `<Name>`   | reference to a named structure, expanded inline |
| `x?`       | optional token |
| `( a b )?` | groups several tokens as one unit |

Examples :
- `ssib` → string · string · int · bool
- `si[iii]` → string, then `i` = number of iterations, then the triplet `iii` repeated.

## API

- `GET /api/packets.json` grouped by direction : `{ "in"|"out" : { "<Name>" : { "custom"?, "layout" } } }`
- `GET /api/fields.json` same as above, with only the detail (`fields`, `description`…)
- `GET /api/templates.json` shared structures (including enums)
