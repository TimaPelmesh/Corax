pad = " " * 2048
text = (
    "namespace Corax.Client;\n\n"
    "internal static class ConfigSlot\n"
    "{\n"
    "    internal const string Slot =\n"
    '        "<<<CORAX_CFG_BEGIN>>>" +\n'
    '        "{}" +\n'
    '        "' + pad + '" +\n'
    '        "<<<CORAX_CFG_END>>>";\n'
    "}\n"
)
path = __file__.replace("_gen_slot.py", "ConfigSlot.cs")
with open(path, "w", encoding="utf-8", newline="\n") as handle:
    handle.write(text)
print(path, len(text))
