type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);

/** App Server uses strict JSON schemas: optional properties travel as nullable required fields. */
export function strictCodexSchema(input: Schema): Schema {
  const result = { ...input };
  if (object(input.items)) result.items = strictCodexSchema(input.items);
  if (input.type === 'object') {
    const properties = object(input.properties) ? input.properties : {};
    const required = new Set(Array.isArray(input.required) ? input.required : []);
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
      const property = strictCodexSchema(object(value) ? value : {});
      return [key, required.has(key) ? property : { anyOf: [property, { type: 'null' }] }];
    }));
    result.required = Object.keys(properties);
    result.additionalProperties = false;
  }
  return result;
}

export function restoreOptionalFields(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value) && object(schema.items)) return value.map((v) => restoreOptionalFields(v, schema.items as Schema));
  if (!object(value) || !object(schema.properties)) return value;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== null || required.has(key) || !Object.hasOwn(properties, key)).map(([key, item]) => [key, object(properties[key]) ? restoreOptionalFields(item, properties[key]) : item]));
}
