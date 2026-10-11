// Sheet column names that mean a global biosample field. A column named here is
// created on the study as an alias of that global field (its own display name,
// linked by global_field_idx), so its values are stored as the global field and
// read back under it, rather than as an unrelated study-local column.
//
// TODO: discuss reserved global field decisions with the team: which legacy
// Qiita/EBI column names alias which global fields, and what happens to a
// column whose values don't all fit (the ones commented out below).

/** Sheet column name -> global field internal_name. */
export const GLOBAL_FIELD_ALIASES: Record<string, string> = {
  env_biome: 'broad_scale_environmental_context',
  // env_feature: 'local_environmental_context', -- legacy sheets spell
  //   "human associated habitat" without the ENVO label's hyphen.
  // env_material: 'environmental_medium', -- "blood material" has no ENVO term
  //   in the seeded terminology.
  geo_loc_name: 'geographic_location_country_or_sea',
  // country: 'geographic_location_country_or_sea', -- the same global field as
  //   geo_loc_name (a sample holds one value per global field), and controls
  //   carry "control sample" in it.
  latitude: 'geographic_location_latitude',
  longitude: 'geographic_location_longitude'
  // host_taxid: 'host_taxon_id', -- controls carry "control sample", which is
  //   not a taxon.
};
